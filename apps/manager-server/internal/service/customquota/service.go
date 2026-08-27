package customquota

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

const (
	queryTimeout        = 20 * time.Second
	maxResponseBytes    = 1024 * 1024
	defaultAPIKeyHeader = "Authorization"
)

type ManagerConfigResolver interface {
	ResolveManagerConfig(ctx context.Context) (store.ManagerConfig, bool, error)
}

type CustomQuotaCredentialPersister interface {
	PersistCustomQuotaCredentials(ctx context.Context, bindingKey, accessToken, refreshToken string, expiresAtMS int64) error
}

type Service struct {
	resolver            ManagerConfigResolver
	credentialPersister CustomQuotaCredentialPersister
	bindingLocksMu      sync.Mutex
	bindingLocks        map[string]*sync.Mutex
}

type QueryRequest struct {
	BindingKey string `json:"bindingKey"`
}

type QueryResponse struct {
	BindingKey  string          `json:"bindingKey"`
	Status      int             `json:"status"`
	Body        json.RawMessage `json:"body"`
	FetchedAtMS int64           `json:"fetchedAtMs"`
}

type QueryError struct {
	Status  int
	Message string
}

func (e *QueryError) Error() string {
	return e.Message
}

func ErrorStatus(err error) int {
	var queryErr *QueryError
	if errors.As(err, &queryErr) && queryErr.Status > 0 {
		return queryErr.Status
	}
	return http.StatusInternalServerError
}

func New(resolver ManagerConfigResolver, persisters ...CustomQuotaCredentialPersister) *Service {
	var persister CustomQuotaCredentialPersister
	if len(persisters) > 0 {
		persister = persisters[0]
	}
	return &Service{
		resolver:            resolver,
		credentialPersister: persister,
		bindingLocks:        make(map[string]*sync.Mutex),
	}
}

func (s *Service) Query(ctx context.Context, req QueryRequest) (QueryResponse, error) {
	bindingKey := strings.TrimSpace(req.BindingKey)
	if bindingKey == "" {
		return QueryResponse{}, &QueryError{Status: http.StatusBadRequest, Message: "bindingKey is required"}
	}
	cfg, _, err := s.resolver.ResolveManagerConfig(ctx)
	if err != nil {
		return QueryResponse{}, err
	}
	binding, ok := cfg.CustomQuota.Bindings[bindingKey]
	if !ok {
		return QueryResponse{}, &QueryError{Status: http.StatusNotFound, Message: "custom quota binding not found"}
	}
	if binding.Enabled != nil && !*binding.Enabled {
		return QueryResponse{}, &QueryError{Status: http.StatusBadRequest, Message: "custom quota binding is disabled"}
	}
	kind := strings.ToLower(strings.TrimSpace(binding.Kind))
	if kind != "sub2api" && kind != "custom_get" {
		return QueryResponse{}, &QueryError{Status: http.StatusBadRequest, Message: "custom quota kind must be sub2api or custom_get"}
	}

	accessToken := ""
	if kind == "sub2api" {
		binding, accessToken, err = s.ensureSub2APIAccessToken(ctx, bindingKey, false)
		if err != nil {
			return QueryResponse{}, err
		}
	}
	endpoint, err := endpointForBinding(binding)
	if err != nil {
		return QueryResponse{}, err
	}
	client, err := buildHTTPClient(binding.ProxyURL)
	if err != nil {
		return QueryResponse{}, err
	}

	buildRequest := func(activeBinding store.ManagerCustomQuotaBinding, token string) (*http.Request, error) {
		request, requestErr := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if requestErr != nil {
			return nil, &QueryError{Status: http.StatusBadRequest, Message: "custom quota url is invalid"}
		}
		request.Header.Set("Accept", "application/json")
		request.Header.Set("User-Agent", "cpa-manager-plus-custom-quota/1")
		for name, value := range activeBinding.Headers {
			name = strings.TrimSpace(name)
			if !isValidHeaderName(name) || strings.ContainsAny(value, "\r\n") {
				return nil, &QueryError{Status: http.StatusBadRequest, Message: "custom quota headers are invalid"}
			}
			request.Header.Set(name, value)
		}
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
			return request, nil
		}
		if authErr := applyAuthentication(request, activeBinding); authErr != nil {
			return nil, authErr
		}
		return request, nil
	}

	request, err := buildRequest(binding, accessToken)
	if err != nil {
		return QueryResponse{}, err
	}
	response, err := client.Do(request)
	if err != nil {
		return QueryResponse{}, &QueryError{Status: http.StatusBadGateway, Message: "custom quota request failed"}
	}
	if kind == "sub2api" && accessToken != "" && response.StatusCode == http.StatusUnauthorized {
		_ = response.Body.Close()
		binding, accessToken, err = s.ensureSub2APIAccessToken(ctx, bindingKey, true)
		if err != nil {
			return QueryResponse{}, err
		}
		endpoint, err = endpointForBinding(binding)
		if err != nil {
			return QueryResponse{}, err
		}
		request, err = buildRequest(binding, accessToken)
		if err != nil {
			return QueryResponse{}, err
		}
		response, err = client.Do(request)
		if err != nil {
			return QueryResponse{}, &QueryError{Status: http.StatusBadGateway, Message: "custom quota request failed"}
		}
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return QueryResponse{}, &QueryError{
			Status:  http.StatusBadGateway,
			Message: fmt.Sprintf("custom quota endpoint returned HTTP %d", response.StatusCode),
		}
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return QueryResponse{}, &QueryError{Status: http.StatusBadGateway, Message: "read custom quota response failed"}
	}
	if len(body) > maxResponseBytes {
		return QueryResponse{}, &QueryError{Status: http.StatusBadGateway, Message: "custom quota response is too large"}
	}
	if !json.Valid(body) {
		return QueryResponse{}, &QueryError{Status: http.StatusBadGateway, Message: "custom quota response is not valid JSON"}
	}
	return QueryResponse{
		BindingKey:  bindingKey,
		Status:      response.StatusCode,
		Body:        json.RawMessage(body),
		FetchedAtMS: time.Now().UnixMilli(),
	}, nil
}

func endpointForBinding(binding store.ManagerCustomQuotaBinding) (string, error) {
	rawURL := strings.TrimSpace(binding.URL)
	if strings.EqualFold(strings.TrimSpace(binding.Kind), "sub2api") {
		return sub2APIEndpoint(rawURL, "subscriptions")
	}

	parsed, err := validateHTTPURL(rawURL)
	if err != nil {
		return "", &QueryError{Status: http.StatusBadRequest, Message: err.Error()}
	}
	return parsed.String(), nil
}

func validateHTTPURL(rawURL string) (*url.URL, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" || parsed.User != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, errors.New("custom quota url must be an http or https url without credentials")
	}
	if strings.ContainsAny(parsed.Host, "\r\n") {
		return nil, errors.New("custom quota url is invalid")
	}
	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil {
		return nil, errors.New("custom quota url is invalid")
	}
	for name := range query {
		normalized := strings.ToLower(strings.NewReplacer("-", "", "_", "").Replace(strings.TrimSpace(name)))
		switch normalized {
		case "key", "apikey", "accesskey", "token", "accesstoken", "authtoken", "authorization", "credential", "password", "secret":
			return nil, errors.New("custom quota url must not contain credential query parameters")
		}
		if strings.Contains(normalized, "token") || strings.Contains(normalized, "secret") || strings.Contains(normalized, "password") {
			return nil, errors.New("custom quota url must not contain credential query parameters")
		}
	}
	return parsed, nil
}

const sub2APIAccessTokenRefreshSkew = 60 * time.Second

type sub2APITokenPair struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
}

type sub2APIAuthError struct {
	status int
}

func (e *sub2APIAuthError) Error() string {
	return "sub2api authentication request failed"
}

func sub2APIEndpoint(rawURL, suffix string) (string, error) {
	parsed, err := validateHTTPURL(rawURL)
	if err != nil {
		return "", &QueryError{Status: http.StatusBadRequest, Message: err.Error()}
	}
	path := strings.TrimRight(parsed.Path, "/")
	for _, endpointPath := range []string{"/api/v1/subscriptions", "/v1/subscriptions", "/api/v1/usage", "/v1/usage"} {
		if strings.HasSuffix(path, endpointPath) {
			path = strings.TrimSuffix(path, endpointPath)
			break
		}
	}
	path = strings.TrimRight(path, "/")
	switch {
	case strings.HasSuffix(path, "/api/v1"):
	case strings.HasSuffix(path, "/v1"):
		path = strings.TrimSuffix(path, "/v1") + "/api/v1"
	case strings.HasSuffix(path, "/api"):
		path += "/v1"
	default:
		path += "/api/v1"
	}
	parsed.Path = path + "/" + strings.TrimLeft(suffix, "/")
	parsed.RawPath = ""
	return parsed.String(), nil
}

func (s *Service) bindingLock(bindingKey string) *sync.Mutex {
	s.bindingLocksMu.Lock()
	defer s.bindingLocksMu.Unlock()
	if s.bindingLocks == nil {
		s.bindingLocks = make(map[string]*sync.Mutex)
	}
	if lock, ok := s.bindingLocks[bindingKey]; ok {
		return lock
	}
	lock := &sync.Mutex{}
	s.bindingLocks[bindingKey] = lock
	return lock
}

func (s *Service) ensureSub2APIAccessToken(
	ctx context.Context,
	bindingKey string,
	forceRefresh bool,
) (store.ManagerCustomQuotaBinding, string, error) {
	lock := s.bindingLock(bindingKey)
	lock.Lock()
	defer lock.Unlock()

	cfg, _, err := s.resolver.ResolveManagerConfig(ctx)
	if err != nil {
		return store.ManagerCustomQuotaBinding{}, "", err
	}
	binding, ok := cfg.CustomQuota.Bindings[bindingKey]
	if !ok {
		return store.ManagerCustomQuotaBinding{}, "", &QueryError{Status: http.StatusNotFound, Message: "custom quota binding not found"}
	}
	if binding.Enabled != nil && !*binding.Enabled {
		return store.ManagerCustomQuotaBinding{}, "", &QueryError{Status: http.StatusBadRequest, Message: "custom quota binding is disabled"}
	}
	if !hasSub2APICredentials(binding) {
		return binding, "", nil
	}

	accessToken := strings.TrimSpace(binding.AccessToken)
	expiresAtMS := binding.AccessTokenExpiresAtMS
	if expiresAtMS == 0 {
		expiresAtMS = accessTokenExpiryMS(accessToken)
	}
	if !forceRefresh && accessToken != "" && expiresAtMS > time.Now().Add(sub2APIAccessTokenRefreshSkew).UnixMilli() {
		return binding, accessToken, nil
	}

	refreshToken := strings.TrimSpace(binding.RefreshToken)
	if refreshToken != "" {
		pair, refreshErr := requestSub2APITokenPair(ctx, binding, "auth/refresh", map[string]string{
			"refresh_token": refreshToken,
		})
		if refreshErr == nil {
			return s.persistSub2APITokenPair(ctx, bindingKey, binding, pair)
		}
		if !isInvalidRefreshTokenError(refreshErr) {
			return store.ManagerCustomQuotaBinding{}, "", sub2APIAuthenticationError(refreshErr)
		}
	}

	if strings.TrimSpace(binding.Username) == "" || binding.Password == "" {
		return store.ManagerCustomQuotaBinding{}, "", &QueryError{
			Status:  http.StatusBadRequest,
			Message: "Sub2API username and password are required when token refresh is unavailable",
		}
	}
	pair, loginErr := requestSub2APITokenPair(ctx, binding, "auth/login", map[string]string{
		"email":    strings.TrimSpace(binding.Username),
		"password": binding.Password,
	})
	if loginErr != nil {
		return store.ManagerCustomQuotaBinding{}, "", sub2APIAuthenticationError(loginErr)
	}
	return s.persistSub2APITokenPair(ctx, bindingKey, binding, pair)
}

func hasSub2APICredentials(binding store.ManagerCustomQuotaBinding) bool {
	return binding.Password != "" ||
		strings.TrimSpace(binding.AccessToken) != "" ||
		strings.TrimSpace(binding.RefreshToken) != ""
}

func (s *Service) persistSub2APITokenPair(
	ctx context.Context,
	bindingKey string,
	binding store.ManagerCustomQuotaBinding,
	pair sub2APITokenPair,
) (store.ManagerCustomQuotaBinding, string, error) {
	accessToken := strings.TrimSpace(pair.AccessToken)
	refreshToken := strings.TrimSpace(pair.RefreshToken)
	if accessToken == "" || refreshToken == "" {
		return store.ManagerCustomQuotaBinding{}, "", &QueryError{Status: http.StatusBadGateway, Message: "Sub2API authentication did not return a refresh token"}
	}
	expiresAtMS := time.Now().Add(time.Duration(pair.ExpiresIn) * time.Second).UnixMilli()
	if pair.ExpiresIn <= 0 {
		expiresAtMS = accessTokenExpiryMS(accessToken)
	}
	if s.credentialPersister == nil {
		return store.ManagerCustomQuotaBinding{}, "", &QueryError{Status: http.StatusInternalServerError, Message: "custom quota credential persistence is not configured"}
	}
	if err := s.credentialPersister.PersistCustomQuotaCredentials(ctx, bindingKey, accessToken, refreshToken, expiresAtMS); err != nil {
		return store.ManagerCustomQuotaBinding{}, "", &QueryError{Status: http.StatusInternalServerError, Message: "persist Sub2API credentials failed"}
	}
	binding.AccessToken = accessToken
	binding.RefreshToken = refreshToken
	binding.AccessTokenExpiresAtMS = expiresAtMS
	binding.AccessTokenConfigured = true
	binding.RefreshTokenConfigured = true
	return binding, accessToken, nil
}

func requestSub2APITokenPair(
	ctx context.Context,
	binding store.ManagerCustomQuotaBinding,
	suffix string,
	payload map[string]string,
) (sub2APITokenPair, error) {
	endpoint, err := sub2APIEndpoint(binding.URL, suffix)
	if err != nil {
		return sub2APITokenPair{}, &sub2APIAuthError{status: http.StatusBadRequest}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return sub2APITokenPair{}, &sub2APIAuthError{status: http.StatusBadRequest}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return sub2APITokenPair{}, &sub2APIAuthError{status: http.StatusBadRequest}
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "cpa-manager-plus-custom-quota/1")
	for name, value := range binding.Headers {
		name = strings.TrimSpace(name)
		if !isValidHeaderName(name) || strings.ContainsAny(value, "\r\n") {
			return sub2APITokenPair{}, &sub2APIAuthError{status: http.StatusBadRequest}
		}
		request.Header.Set(name, value)
	}
	client, err := buildHTTPClient(binding.ProxyURL)
	if err != nil {
		return sub2APITokenPair{}, &sub2APIAuthError{status: http.StatusBadRequest}
	}
	response, err := client.Do(request)
	if err != nil {
		return sub2APITokenPair{}, &sub2APIAuthError{}
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return sub2APITokenPair{}, &sub2APIAuthError{status: response.StatusCode}
	}
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(responseBody) > maxResponseBytes {
		return sub2APITokenPair{}, &sub2APIAuthError{status: response.StatusCode}
	}
	pair, err := decodeSub2APITokenPair(responseBody)
	if err != nil {
		return sub2APITokenPair{}, &sub2APIAuthError{status: response.StatusCode}
	}
	return pair, nil
}

func decodeSub2APITokenPair(body []byte) (sub2APITokenPair, error) {
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return sub2APITokenPair{}, err
	}
	payload := body
	if len(envelope.Data) > 0 && string(envelope.Data) != "null" {
		payload = envelope.Data
	}
	var pair sub2APITokenPair
	if err := json.Unmarshal(payload, &pair); err != nil {
		return sub2APITokenPair{}, err
	}
	if strings.TrimSpace(pair.AccessToken) == "" || strings.TrimSpace(pair.RefreshToken) == "" {
		return sub2APITokenPair{}, errors.New("token pair is incomplete")
	}
	return pair, nil
}

func isInvalidRefreshTokenError(err error) bool {
	var authErr *sub2APIAuthError
	if !errors.As(err, &authErr) {
		return false
	}
	return authErr.status >= http.StatusBadRequest && authErr.status < http.StatusInternalServerError
}

func sub2APIAuthenticationError(err error) error {
	if err == nil {
		return nil
	}
	return &QueryError{Status: http.StatusBadGateway, Message: "Sub2API authentication failed"}
}

func accessTokenExpiryMS(token string) int64 {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return 0
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		decoded, err = base64.URLEncoding.DecodeString(parts[1])
	}
	if err != nil {
		return 0
	}
	decoder := json.NewDecoder(strings.NewReader(string(decoded)))
	decoder.UseNumber()
	var claims struct {
		ExpiresAt json.Number `json:"exp"`
	}
	if err := decoder.Decode(&claims); err != nil {
		return 0
	}
	seconds, err := strconv.ParseInt(claims.ExpiresAt.String(), 10, 64)
	if err != nil || seconds <= 0 {
		return 0
	}
	return seconds * 1000
}

func isValidHeaderName(name string) bool {
	if name == "" {
		return false
	}
	for i := 0; i < len(name); i++ {
		char := name[i]
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') {
			continue
		}
		switch char {
		case '!', '#', '$', '%', '&', '\'', '*', '+', '-', '.', '^', '_', '`', '|', '~':
			continue
		default:
			return false
		}
	}
	return true
}

func applyAuthentication(request *http.Request, binding store.ManagerCustomQuotaBinding) error {
	mode := strings.ToLower(strings.TrimSpace(binding.AuthMode))
	if mode == "" {
		mode = "bearer"
	}
	switch mode {
	case "none":
		return nil
	case "bearer":
		apiKey := strings.TrimSpace(binding.QuotaAPIKey)
		if apiKey == "" || strings.ContainsAny(apiKey, "\r\n") {
			return &QueryError{Status: http.StatusBadRequest, Message: "custom quota API key is required for bearer authentication"}
		}
		request.Header.Set("Authorization", "Bearer "+apiKey)
	case "header":
		name := strings.TrimSpace(binding.APIKeyHeader)
		if name == "" {
			name = defaultAPIKeyHeader
		}
		apiKey := strings.TrimSpace(binding.QuotaAPIKey)
		if !isValidHeaderName(name) || apiKey == "" || strings.ContainsAny(apiKey, "\r\n") {
			return &QueryError{Status: http.StatusBadRequest, Message: "custom quota header authentication requires a header name and API key"}
		}
		request.Header.Set(name, apiKey)
	default:
		return &QueryError{Status: http.StatusBadRequest, Message: "custom quota authMode must be bearer, header, or none"}
	}
	return nil
}

func buildHTTPClient(proxyURL string) (*http.Client, error) {
	transport, ok := http.DefaultTransport.(*http.Transport)
	if ok {
		transport = transport.Clone()
	} else {
		transport = &http.Transport{Proxy: http.ProxyFromEnvironment}
	}
	if strings.TrimSpace(proxyURL) != "" {
		parsed, err := validateHTTPURL(strings.TrimSpace(proxyURL))
		if err != nil {
			return nil, &QueryError{Status: http.StatusBadRequest, Message: "custom quota proxyUrl must be an http or https url without credentials"}
		}
		transport.Proxy = http.ProxyURL(parsed)
	}
	return &http.Client{
		Transport:     transport,
		Timeout:       queryTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}, nil
}
