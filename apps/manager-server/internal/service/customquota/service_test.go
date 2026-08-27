package customquota

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

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

func TestQuerySub2APIAppendsUsagePathAndUsesBearerAuthentication(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if r.URL.Path != "/v1/usage" {
			t.Errorf("path = %s, want /v1/usage", r.URL.Path)
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
						Kind:         "sub2api",
						URL:          upstream.URL,
						QuotaAPIKey:  "quota-secret",
						AuthMode:     "bearer",
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
