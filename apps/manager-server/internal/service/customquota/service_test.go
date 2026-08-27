package customquota

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

type staticManagerConfigResolver struct {
	config store.ManagerConfig
	found  bool
	err    error
}

func (r staticManagerConfigResolver) ResolveManagerConfig(context.Context) (store.ManagerConfig, bool, error) {
	return r.config, r.found, r.err
}

func TestQuerySub2APISubscriptionsUsesBearerAuthentication(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if r.URL.Path != "/api/v1/subscriptions" {
			t.Errorf("path = %s, want /api/v1/subscriptions", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer quota-secret" {
			t.Errorf("authorization = %q, want bearer credential", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"quota":{"used":2,"limit":10}}`))
	}))
	t.Cleanup(upstream.Close)

	service := New(staticManagerConfigResolver{
		found: true,
		config: store.ManagerConfig{
			CustomQuota: store.ManagerCustomQuotaConfig{
				Bindings: map[string]store.ManagerCustomQuotaBinding{
					"binding": {
						Kind:        "sub2api",
						URL:         upstream.URL,
						Username:    "legacy@example.test",
						QuotaAPIKey: "quota-secret",
						AuthMode:    "bearer",
					},
				},
			},
		},
	})

	result, err := service.Query(context.Background(), QueryRequest{BindingKey: "binding"})
	if err != nil {
		t.Fatalf("query custom quota: %v", err)
	}
	if result.Status != http.StatusOK {
		t.Fatalf("status = %d, want %d", result.Status, http.StatusOK)
	}
	if result.BindingKey != "binding" {
		t.Fatalf("binding key = %q, want binding", result.BindingKey)
	}
	if len(result.Body) == 0 {
		t.Fatal("expected JSON response body")
	}
}

func TestQueryCustomQuotaDoesNotFollowRedirects(t *testing.T) {
	var followed atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		followed.Store(true)
	}))
	t.Cleanup(target.Close)
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	t.Cleanup(source.Close)

	service := New(staticManagerConfigResolver{
		found: true,
		config: store.ManagerConfig{
			CustomQuota: store.ManagerCustomQuotaConfig{
				Bindings: map[string]store.ManagerCustomQuotaBinding{
					"binding": {Kind: "custom_get", URL: source.URL, AuthMode: "none"},
				},
			},
		},
	})

	_, err := service.Query(context.Background(), QueryRequest{BindingKey: "binding"})
	if err == nil {
		t.Fatal("expected redirect response to fail")
	}
	if got := ErrorStatus(err); got != http.StatusBadGateway {
		t.Fatalf("error status = %d, want %d", got, http.StatusBadGateway)
	}
	if followed.Load() {
		t.Fatal("custom quota query followed a redirect")
	}
}

type persistedCredential struct {
	bindingKey   string
	accessToken  string
	refreshToken string
	expiresAtMS  int64
}

type recordingCredentialPersister struct {
	mu    sync.Mutex
	calls []persistedCredential
}

func (p *recordingCredentialPersister) PersistCustomQuotaCredentials(
	_ context.Context,
	bindingKey, accessToken, refreshToken string,
	expiresAtMS int64,
) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls = append(p.calls, persistedCredential{
		bindingKey:   bindingKey,
		accessToken:  accessToken,
		refreshToken: refreshToken,
		expiresAtMS:  expiresAtMS,
	})
	return nil
}

func (p *recordingCredentialPersister) callCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.calls)
}

func (p *recordingCredentialPersister) lastCall() persistedCredential {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls[len(p.calls)-1]
}

type mutableManagerConfigResolver struct {
	mu     sync.Mutex
	config store.ManagerConfig
}

func (r *mutableManagerConfigResolver) ResolveManagerConfig(context.Context) (store.ManagerConfig, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.config, true, nil
}

func (r *mutableManagerConfigResolver) updateTokens(bindingKey, accessToken, refreshToken string, expiresAtMS int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	bindings := make(map[string]store.ManagerCustomQuotaBinding, len(r.config.CustomQuota.Bindings))
	for key, binding := range r.config.CustomQuota.Bindings {
		bindings[key] = binding
	}
	binding := bindings[bindingKey]
	binding.AccessToken = accessToken
	binding.RefreshToken = refreshToken
	binding.AccessTokenExpiresAtMS = expiresAtMS
	bindings[bindingKey] = binding
	r.config.CustomQuota.Bindings = bindings
}

type updatingCredentialPersister struct {
	resolver *mutableManagerConfigResolver
	calls    atomic.Int32
}

func (p *updatingCredentialPersister) PersistCustomQuotaCredentials(
	_ context.Context,
	bindingKey, accessToken, refreshToken string,
	expiresAtMS int64,
) error {
	p.calls.Add(1)
	p.resolver.updateTokens(bindingKey, accessToken, refreshToken, expiresAtMS)
	return nil
}

func sub2APIConfig(binding store.ManagerCustomQuotaBinding) store.ManagerConfig {
	return store.ManagerConfig{
		CustomQuota: store.ManagerCustomQuotaConfig{
			Bindings: map[string]store.ManagerCustomQuotaBinding{"binding": binding},
		},
	}
}

func TestSub2APIEndpointNormalizesSubscriptionPaths(t *testing.T) {
	cases := []struct {
		name  string
		input string
		path  string
	}{
		{name: "host", input: "https://quota.example.test", path: "/api/v1/subscriptions"},
		{name: "api", input: "https://quota.example.test/api", path: "/api/v1/subscriptions"},
		{name: "api v1", input: "https://quota.example.test/api/v1", path: "/api/v1/subscriptions"},
		{name: "legacy v1 subscriptions", input: "https://quota.example.test/v1/subscriptions", path: "/api/v1/subscriptions"},
		{name: "legacy usage", input: "https://quota.example.test/v1/usage", path: "/api/v1/subscriptions"},
		{name: "current subscriptions", input: "https://quota.example.test/api/v1/subscriptions", path: "/api/v1/subscriptions"},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			endpoint, err := sub2APIEndpoint(testCase.input, "subscriptions")
			if err != nil {
				t.Fatalf("build endpoint: %v", err)
			}
			parsed, err := url.Parse(endpoint)
			if err != nil {
				t.Fatalf("parse endpoint: %v", err)
			}
			if parsed.Path != testCase.path {
				t.Errorf("path = %s, want %s", parsed.Path, testCase.path)
			}
		})
	}
}

func TestQuerySub2APILoginPersistsTokens(t *testing.T) {
	var loginCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/auth/login":
			loginCalls.Add(1)
			if r.Method != http.MethodPost {
				t.Errorf("login method = %s, want POST", r.Method)
			}
			var payload struct {
				Email    string `json:"email"`
				Password string `json:"password"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Errorf("decode login payload: %v", err)
			}
			if payload.Email != "user@example.test" || payload.Password != "configured-password" {
				t.Error("login payload did not contain the configured credentials")
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":{"access_token":"access-from-login","refresh_token":"refresh-from-login","expires_in":3600}}`))
		case "/api/v1/subscriptions":
			if got := r.Header.Get("Authorization"); got != "Bearer access-from-login" {
				t.Error("subscription request did not use the login access token")
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":{"weekly_usage_usd":2,"group":{"weekly_limit_usd":10}}}`))
		default:
			t.Errorf("unexpected request path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(upstream.Close)

	persister := &recordingCredentialPersister{}
	service := New(staticManagerConfigResolver{
		found: true,
		config: sub2APIConfig(store.ManagerCustomQuotaBinding{
			Kind:     "sub2api",
			URL:      upstream.URL,
			Username: "user@example.test",
			Password: "configured-password",
		}),
	}, persister)

	result, err := service.Query(context.Background(), QueryRequest{BindingKey: "binding"})
	if err != nil {
		t.Fatalf("query custom quota: %v", err)
	}
	if result.Status != http.StatusOK {
		t.Fatalf("status = %d, want %d", result.Status, http.StatusOK)
	}
	if loginCalls.Load() != 1 {
		t.Fatalf("login calls = %d, want 1", loginCalls.Load())
	}
	if persister.callCount() != 1 {
		t.Fatalf("persist calls = %d, want 1", persister.callCount())
	}
	saved := persister.lastCall()
	if saved.bindingKey != "binding" || saved.accessToken != "access-from-login" || saved.refreshToken != "refresh-from-login" {
		t.Error("login token pair was not persisted for the binding")
	}
	if saved.expiresAtMS <= time.Now().UnixMilli() {
		t.Error("persisted access token expiry was not in the future")
	}
}

func TestQuerySub2APIRefreshesExpiredAccessToken(t *testing.T) {
	var refreshCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/auth/refresh":
			refreshCalls.Add(1)
			if r.Method != http.MethodPost {
				t.Errorf("refresh method = %s, want POST", r.Method)
			}
			var payload struct {
				RefreshToken string `json:"refresh_token"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Errorf("decode refresh payload: %v", err)
			}
			if payload.RefreshToken != "refresh-old" {
				t.Error("refresh request did not use the stored refresh token")
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":{"access_token":"access-from-refresh","refresh_token":"refresh-rotated","expires_in":3600}}`))
		case "/api/v1/subscriptions":
			if got := r.Header.Get("Authorization"); got != "Bearer access-from-refresh" {
				t.Error("subscription request did not use the refreshed access token")
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":{"weekly_usage_usd":1,"group":{"weekly_limit_usd":5}}}`))
		default:
			t.Errorf("unexpected request path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(upstream.Close)

	persister := &recordingCredentialPersister{}
	service := New(staticManagerConfigResolver{
		found: true,
		config: sub2APIConfig(store.ManagerCustomQuotaBinding{
			Kind:                   "sub2api",
			URL:                    upstream.URL,
			AccessToken:            "access-expired",
			AccessTokenExpiresAtMS: 1,
			RefreshToken:           "refresh-old",
		}),
	}, persister)

	if _, err := service.Query(context.Background(), QueryRequest{BindingKey: "binding"}); err != nil {
		t.Fatalf("query custom quota: %v", err)
	}
	if refreshCalls.Load() != 1 {
		t.Fatalf("refresh calls = %d, want 1", refreshCalls.Load())
	}
	if persister.callCount() != 1 {
		t.Fatalf("persist calls = %d, want 1", persister.callCount())
	}
	saved := persister.lastCall()
	if saved.refreshToken != "refresh-rotated" {
		t.Error("rotated refresh token was not persisted")
	}
}

func TestQuerySub2APIFallsBackToLoginAfterInvalidRefresh(t *testing.T) {
	var pathsMu sync.Mutex
	var paths []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pathsMu.Lock()
		paths = append(paths, r.URL.Path)
		pathsMu.Unlock()
		switch r.URL.Path {
		case "/api/v1/auth/refresh":
			w.WriteHeader(http.StatusUnauthorized)
		case "/api/v1/auth/login":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":{"access_token":"access-from-fallback","refresh_token":"refresh-from-fallback","expires_in":3600}}`))
		case "/api/v1/subscriptions":
			if got := r.Header.Get("Authorization"); got != "Bearer access-from-fallback" {
				t.Error("subscription request did not use the fallback login token")
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":{"weekly_usage_usd":0,"group":{"weekly_limit_usd":5}}}`))
		default:
			t.Errorf("unexpected request path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(upstream.Close)

	persister := &recordingCredentialPersister{}
	service := New(staticManagerConfigResolver{
		found: true,
		config: sub2APIConfig(store.ManagerCustomQuotaBinding{
			Kind:                   "sub2api",
			URL:                    upstream.URL,
			Username:               "user@example.test",
			Password:               "configured-password",
			AccessToken:            "access-expired",
			AccessTokenExpiresAtMS: 1,
			RefreshToken:           "refresh-invalid",
		}),
	}, persister)

	if _, err := service.Query(context.Background(), QueryRequest{BindingKey: "binding"}); err != nil {
		t.Fatalf("query custom quota: %v", err)
	}
	pathsMu.Lock()
	gotPaths := append([]string(nil), paths...)
	pathsMu.Unlock()
	wantPaths := []string{"/api/v1/auth/refresh", "/api/v1/auth/login", "/api/v1/subscriptions"}
	if strings.Join(gotPaths, ",") != strings.Join(wantPaths, ",") {
		t.Fatalf("request sequence = %s, want %s", strings.Join(gotPaths, ","), strings.Join(wantPaths, ","))
	}
}

func TestQuerySub2APIRetriesOnceAfterUnauthorized(t *testing.T) {
	var subscriptionCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/auth/refresh":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":{"access_token":"access-after-401","refresh_token":"refresh-after-401","expires_in":3600}}`))
		case "/api/v1/subscriptions":
			if subscriptionCalls.Add(1) == 1 {
				if got := r.Header.Get("Authorization"); got != "Bearer access-before-401" {
					t.Error("first subscription request did not use the stored access token")
				}
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			if got := r.Header.Get("Authorization"); got != "Bearer access-after-401" {
				t.Error("retry subscription request did not use the refreshed access token")
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":{"weekly_usage_usd":3,"group":{"weekly_limit_usd":5}}}`))
		default:
			t.Errorf("unexpected request path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(upstream.Close)

	service := New(staticManagerConfigResolver{
		found: true,
		config: sub2APIConfig(store.ManagerCustomQuotaBinding{
			Kind:                   "sub2api",
			URL:                    upstream.URL,
			AccessToken:            "access-before-401",
			AccessTokenExpiresAtMS: time.Now().Add(time.Hour).UnixMilli(),
			RefreshToken:           "refresh-before-401",
		}),
	}, &recordingCredentialPersister{})

	result, err := service.Query(context.Background(), QueryRequest{BindingKey: "binding"})
	if err != nil {
		t.Fatalf("query custom quota: %v", err)
	}
	if result.Status != http.StatusOK {
		t.Fatalf("status = %d, want %d", result.Status, http.StatusOK)
	}
	if subscriptionCalls.Load() != 2 {
		t.Fatalf("subscription calls = %d, want 2", subscriptionCalls.Load())
	}
}

func TestQuerySub2APISerializesConcurrentRefreshes(t *testing.T) {
	var refreshCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/auth/refresh":
			refreshCalls.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":{"access_token":"access-concurrent","refresh_token":"refresh-concurrent","expires_in":3600}}`))
		case "/api/v1/subscriptions":
			if got := r.Header.Get("Authorization"); got != "Bearer access-concurrent" {
				t.Error("concurrent subscription request did not use the persisted access token")
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":{"weekly_usage_usd":1,"group":{"weekly_limit_usd":5}}}`))
		default:
			t.Errorf("unexpected request path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(upstream.Close)

	resolver := &mutableManagerConfigResolver{config: sub2APIConfig(store.ManagerCustomQuotaBinding{
		Kind:                   "sub2api",
		URL:                    upstream.URL,
		AccessToken:            "access-expired",
		AccessTokenExpiresAtMS: 1,
		RefreshToken:           "refresh-before-concurrent",
	})}
	persister := &updatingCredentialPersister{resolver: resolver}
	service := New(resolver, persister)

	var waitGroup sync.WaitGroup
	errs := make(chan error, 2)
	for range 2 {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			_, err := service.Query(context.Background(), QueryRequest{BindingKey: "binding"})
			errs <- err
		}()
	}
	waitGroup.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent query: %v", err)
		}
	}
	if refreshCalls.Load() != 1 || persister.calls.Load() != 1 {
		t.Fatalf("refresh calls = %d, persist calls = %d, want one of each", refreshCalls.Load(), persister.calls.Load())
	}
}

func TestDecodeSub2APITokenPairSupportsDataEnvelope(t *testing.T) {
	bodies := [][]byte{
		[]byte(`{"access_token":"access-direct","refresh_token":"refresh-direct","expires_in":60}`),
		[]byte(`{"data":{"access_token":"access-envelope","refresh_token":"refresh-envelope","expires_in":60}}`),
	}
	for _, body := range bodies {
		pair, err := decodeSub2APITokenPair(body)
		if err != nil {
			t.Fatalf("decode token pair: %v", err)
		}
		if pair.AccessToken == "" || pair.RefreshToken == "" || pair.ExpiresIn != 60 {
			t.Error("decoded token pair was incomplete")
		}
	}
}
