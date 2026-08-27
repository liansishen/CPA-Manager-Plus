package customquota

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

const (
	queryTimeout       = 20 * time.Second
	maxResponseBytes   = 1024 * 1024
	defaultAPIKeyHeader = "Authorization"
)

type ManagerConfigResolver interface {
	ResolveManagerConfig(ctx context.Context) (store.ManagerConfig, bool, error)
}

type Service struct {
	resolver ManagerConfigResolver
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

func New(resolver ManagerConfigResolver) *Service {
	return &Service{resolver: resolver}
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

	endpoint, err := endpointForBinding(binding)
	if err != nil {
		return QueryResponse{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return QueryResponse{}, &QueryError{Status: http.StatusBadRequest, Message: "custom quota url is invalid"}
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "cpa-manager-plus-custom-quota/1")
	for name, value := range binding.Headers {
		name = strings.TrimSpace(name)
		if !isValidHeaderName(name) || strings.ContainsAny(value, "\r\n") {
			return QueryResponse{}, &QueryError{Status: http.StatusBadRequest, Message: "custom quota headers are invalid"}
		}
		request.Header.Set(name, value)
	}
	if err := applyAuthentication(request, binding); err != nil {
		return QueryResponse{}, err
	}

	client, err := buildHTTPClient(binding.ProxyURL)
	if err != nil {
		return QueryResponse{}, err
	}
	response, err := client.Do(request)
	if err != nil {
		return QueryResponse{}, &QueryError{Status: http.StatusBadGateway, Message: "custom quota request failed"}
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
	parsed, err := validateHTTPURL(rawURL)
	if err != nil {
		return "", &QueryError{Status: http.StatusBadRequest, Message: err.Error()}
	}
	kind := strings.ToLower(strings.TrimSpace(binding.Kind))
	if kind == "sub2api" {
		path := strings.TrimRight(parsed.Path, "/")
		switch {
		case strings.HasSuffix(path, "/usage"):
		case strings.HasSuffix(path, "/v1"):
			parsed.Path = path + "/usage"
		default:
			parsed.Path = path + "/v1/usage"
		}
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
