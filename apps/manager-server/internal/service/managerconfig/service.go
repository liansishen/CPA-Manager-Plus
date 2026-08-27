package managerconfig

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	collectorservice "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/collector"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cpa"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

type Source string

const (
	SourceNone Source = ""
	SourceEnv  Source = "env"
	SourceDB   Source = "db"
)

type Response struct {
	Config   store.ManagerConfig `json:"config"`
	Source   string              `json:"source"`
	CPAUsage *cpa.UsageConfig    `json:"cpaUsage,omitempty"`
}

type Service struct {
	cfg       config.Config
	store     *store.Store
	collector *collectorservice.Service
}


func publicManagerConfig(cfg store.ManagerConfig) store.ManagerConfig {
	if cfg.CustomQuota.Bindings == nil {
		return cfg
	}
	publicBindings := make(map[string]store.ManagerCustomQuotaBinding, len(cfg.CustomQuota.Bindings))
	for key, binding := range cfg.CustomQuota.Bindings {
		if strings.TrimSpace(binding.QuotaAPIKey) != "" {
			binding.QuotaAPIKeyConfigured = true
			binding.QuotaAPIKey = ""
		}
		binding.Headers = redactCustomQuotaHeaders(binding.Headers)
		publicBindings[key] = binding
	}
	cfg.CustomQuota.Bindings = publicBindings
	return cfg
}

func ValidateCustomQuotaConfig(cfg store.ManagerCustomQuotaConfig) error {
	for bindingKey, binding := range cfg.Bindings {
		if strings.TrimSpace(bindingKey) == "" {
			return errors.New("custom quota binding key is required")
		}
		switch strings.ToLower(strings.TrimSpace(binding.Kind)) {
		case "sub2api", "custom_get":
		default:
			return errors.New("custom quota kind must be sub2api or custom_get")
		}
		parsed, err := url.Parse(strings.TrimSpace(binding.URL))
		if err != nil || parsed.Host == "" || parsed.User != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || strings.ContainsAny(parsed.Host, "\r\n") {
			return errors.New("custom quota url must be an http or https url without credentials")
		}
		if err := validateCustomQuotaURLQuery(parsed.RawQuery); err != nil {
			return err
		}
		proxyURL := strings.TrimSpace(binding.ProxyURL)
		if proxyURL != "" {
			parsedProxy, proxyErr := url.Parse(proxyURL)
			if proxyErr != nil || parsedProxy.Host == "" || parsedProxy.User != nil || (parsedProxy.Scheme != "http" && parsedProxy.Scheme != "https") || strings.ContainsAny(parsedProxy.Host, "\r\n") {
				return errors.New("custom quota proxyUrl must be an http or https url without credentials")
			}
			if err := validateCustomQuotaURLQuery(parsedProxy.RawQuery); err != nil {
				return err
			}
		}
		if strings.ContainsAny(binding.QuotaAPIKey, "\r\n") {
			return errors.New("custom quota API key is invalid")
		}
		switch strings.ToLower(strings.TrimSpace(binding.AuthMode)) {
		case "", "bearer", "header", "none":
		default:
			return errors.New("custom quota authMode must be bearer, header, or none")
		}
		if err := validateCustomQuotaHeaderName(binding.APIKeyHeader); err != nil {
			return err
		}
		for name, value := range binding.Headers {
			if strings.TrimSpace(name) == "" {
				return errors.New("custom quota header name is invalid")
			}
			if err := validateCustomQuotaHeaderName(name); err != nil {
				return err
			}
			if strings.ContainsAny(value, "\r\n") {
				return errors.New("custom quota header values are invalid")
			}
		}
	}
	return nil
}

func validateCustomQuotaURLQuery(rawQuery string) error {
	query, err := url.ParseQuery(rawQuery)
	if err != nil {
		return errors.New("custom quota url is invalid")
	}
	for name := range query {
		normalized := strings.ToLower(strings.NewReplacer("-", "", "_", "").Replace(strings.TrimSpace(name)))
		switch normalized {
		case "key", "apikey", "accesskey", "token", "accesstoken", "authtoken", "authorization", "credential", "password", "secret":
			return errors.New("custom quota url must not contain credential query parameters")
		}
		if strings.Contains(normalized, "token") || strings.Contains(normalized, "secret") || strings.Contains(normalized, "password") {
			return errors.New("custom quota url must not contain credential query parameters")
		}
	}
	return nil
}

func New(cfg config.Config, store *store.Store, collector *collectorservice.Service) *Service {
	return &Service{
		cfg:       cfg,
		store:     store,
		collector: collector,
	}
}

func (s *Service) Get(ctx context.Context) (Response, error) {
	cfg, source, _, err := s.ResolveManagerConfigWithSource(ctx)
	if err != nil {
		return Response{}, err
	}
	var cpaUsage *cpa.UsageConfig
	if cfg.CPAConnection.CPABaseURL != "" && cfg.CPAConnection.ManagementKey != "" {
		if usageCfg, err := cpa.FetchUsageConfig(
			ctx,
			cfg.CPAConnection.CPABaseURL,
			cfg.CPAConnection.ManagementKey,
		); err == nil {
			cpaUsage = &usageCfg
		}
	}
	return Response{
		Config:   publicManagerConfig(cfg),
		Source:   string(source),
		CPAUsage: cpaUsage,
	}, nil
}


func (s *Service) ResolveManagerConfig(ctx context.Context) (store.ManagerConfig, bool, error) {
	cfg, _, found, err := s.ResolveManagerConfigWithSource(ctx)
	return cfg, found, err
}

func (s *Service) Update(ctx context.Context, submitted store.ManagerConfig) (Response, error) {
	current, source, _, err := s.ResolveManagerConfigWithSource(ctx)
	if err != nil {
		return Response{}, err
	}
	if err := model.ValidateCodexInspectionConfig(submitted.CodexInspection); err != nil {
		return Response{}, err
	}
	if err := ValidateCustomQuotaConfig(submitted.CustomQuota); err != nil {
		return Response{}, err
	}
	next := s.MergeSubmittedManagerConfig(current, submitted)
	if source == SourceEnv && ManagerConfigConnectionDiffers(current, next) {
		return Response{}, errors.New("connection setup is managed by environment variables")
	}
	if next.CPAConnection.CPABaseURL != "" || next.CPAConnection.ManagementKey != "" {
		if next.CPAConnection.CPABaseURL == "" || next.CPAConnection.ManagementKey == "" {
			return Response{}, errors.New("cpaBaseUrl and managementKey are required")
		}
		if err := cpa.ValidateManagementAPI(
			ctx,
			next.CPAConnection.CPABaseURL,
			next.CPAConnection.ManagementKey,
		); err != nil {
			return Response{}, err
		}
		if ManagerCollectorEnabled(next) {
			if err := cpa.ValidateCollectorConfig(
				ctx,
				next.CPAConnection.CPABaseURL,
				next.CPAConnection.ManagementKey,
				next.Collector.PollIntervalMS,
			); err != nil {
				return Response{}, err
			}
			if err := cpa.SetUsageStatisticsEnabled(
				ctx,
				next.CPAConnection.CPABaseURL,
				next.CPAConnection.ManagementKey,
				true,
			); err != nil {
				return Response{}, err
			}
		}
	} else if ManagerCollectorEnabled(next) {
		return Response{}, errors.New("cpaBaseUrl and managementKey are required when request monitoring is enabled")
	}
	if next.CPAConnection.CPABaseURL == "" || next.CPAConnection.ManagementKey == "" {
		if err := s.store.SaveManagerConfig(ctx, next); err != nil {
			return Response{}, err
		}
		_ = s.collector.Stop(context.Background())
		return Response{
			Config: publicManagerConfig(next),
			Source: string(SourceDB),
		}, nil
	}
	if err := s.store.SaveManagerConfig(ctx, next); err != nil {
		return Response{}, err
	}
	setup := SetupFromManagerConfig(next)
	if err := s.store.SaveSetup(ctx, setup); err != nil {
		return Response{}, err
	}
	if ManagerCollectorEnabled(next) {
		_ = s.collector.Start(context.Background(), next)
	} else {
		_ = s.collector.Stop(context.Background())
	}
	return Response{
		Config: publicManagerConfig(next),
		Source: string(SourceDB),
	}, nil
}

func (s *Service) ResolveSetup(ctx context.Context) (store.Setup, bool, error) {
	setup, _, ok, err := s.ResolveSetupWithSource(ctx)
	return setup, ok, err
}

func (s *Service) ResolveSetupWithSource(ctx context.Context) (store.Setup, Source, bool, error) {
	if s.cfg.CPAUpstreamURL != "" && s.cfg.ManagementKey != "" {
		return store.Setup{
			CPAUpstreamURL: cpa.NormalizeBaseURL(s.cfg.CPAUpstreamURL),
			ManagementKey:  s.cfg.ManagementKey,
			Queue:          s.cfg.Queue,
			PopSide:        s.cfg.PopSide,
		}, SourceEnv, true, nil
	}
	if managerCfg, _, ok, err := s.ResolveManagerConfigWithSource(ctx); err != nil {
		return store.Setup{}, SourceNone, false, err
	} else if ok && managerCfg.CPAConnection.CPABaseURL != "" && managerCfg.CPAConnection.ManagementKey != "" {
		return SetupFromManagerConfig(managerCfg), SourceDB, true, nil
	}
	setup, ok, err := s.store.LoadSetup(ctx)
	if !ok || err != nil {
		return setup, SourceNone, ok, err
	}
	return setup, SourceDB, true, nil
}

func (s *Service) ResolveManagerConfigWithSource(ctx context.Context) (store.ManagerConfig, Source, bool, error) {
	cfg := s.DefaultManagerConfig()
	source := SourceNone
	found := false

	if saved, ok, err := s.store.LoadManagerConfig(ctx); err != nil {
		return cfg, source, false, err
	} else if ok {
		cfg = s.MergeSubmittedManagerConfig(cfg, saved)
		source = SourceDB
		found = true
	}

	if setup, ok, err := s.store.LoadSetup(ctx); err != nil {
		return cfg, source, false, err
	} else if ok && cfg.CPAConnection.CPABaseURL == "" && cfg.CPAConnection.ManagementKey == "" {
		cfg.CPAConnection.CPABaseURL = cpa.NormalizeBaseURL(setup.CPAUpstreamURL)
		cfg.CPAConnection.ManagementKey = setup.ManagementKey
		cfg.Collector.Queue = ValueOr(setup.Queue, cfg.Collector.Queue)
		cfg.Collector.PopSide = NormalizePopSide(setup.PopSide, cfg.Collector.PopSide)
		source = SourceDB
		found = true
	}

	if s.cfg.CPAUpstreamURL != "" && s.cfg.ManagementKey != "" {
		cfg.CPAConnection.CPABaseURL = cpa.NormalizeBaseURL(s.cfg.CPAUpstreamURL)
		cfg.CPAConnection.ManagementKey = s.cfg.ManagementKey
		cfg.Collector.CollectorMode = CollectorMode(s.cfg.CollectorMode)
		cfg.Collector.Queue = ValueOr(s.cfg.Queue, cfg.Collector.Queue)
		cfg.Collector.PopSide = NormalizePopSide(s.cfg.PopSide, cfg.Collector.PopSide)
		cfg.Collector.BatchSize = PositiveOrDefault(s.cfg.BatchSize, cfg.Collector.BatchSize, 100)
		cfg.Collector.PollIntervalMS = PositiveOrDefault(int(s.cfg.PollInterval/time.Millisecond), cfg.Collector.PollIntervalMS, 500)
		cfg.Collector.QueryLimit = PositiveOrDefault(s.cfg.QueryLimit, cfg.Collector.QueryLimit, 50000)
		cfg.Collector.TLSSkipVerify = s.cfg.TLSSkipVerify
		source = SourceEnv
		found = true
	}

	return cfg, source, found, nil
}

func (s *Service) DefaultManagerConfig() store.ManagerConfig {
	pollIntervalMS := int(s.cfg.PollInterval / time.Millisecond)
	return store.ManagerConfig{
		Collector: store.ManagerCollectorConfig{
			Enabled:        BoolPtr(true),
			CollectorMode:  CollectorMode(s.cfg.CollectorMode),
			Queue:          ValueOr(s.cfg.Queue, "usage"),
			PopSide:        NormalizePopSide(s.cfg.PopSide, "right"),
			BatchSize:      PositiveOrDefault(s.cfg.BatchSize, 100, 100),
			PollIntervalMS: PositiveOrDefault(pollIntervalMS, 500, 500),
			QueryLimit:     PositiveOrDefault(s.cfg.QueryLimit, 50000, 50000),
			TLSSkipVerify:  s.cfg.TLSSkipVerify,
		},
		CodexInspection: store.DefaultCodexInspectionConfig(),
	}
}

func (s *Service) MergeSubmittedManagerConfig(base store.ManagerConfig, submitted store.ManagerConfig) store.ManagerConfig {
	next := base

	if submitted.CPAConnection.CPABaseURL != "" || submitted.CPAConnection.ManagementKey != "" {
		next.CPAConnection.CPABaseURL = cpa.NormalizeBaseURL(submitted.CPAConnection.CPABaseURL)
		next.CPAConnection.ManagementKey = strings.TrimSpace(submitted.CPAConnection.ManagementKey)
	}

	if submitted.Collector.Enabled != nil {
		next.Collector.Enabled = BoolPtr(*submitted.Collector.Enabled)
	}
	next.Collector.CollectorMode = CollectorMode(ValueOr(submitted.Collector.CollectorMode, next.Collector.CollectorMode))
	next.Collector.Queue = ValueOr(strings.TrimSpace(submitted.Collector.Queue), next.Collector.Queue)
	next.Collector.PopSide = NormalizePopSide(submitted.Collector.PopSide, next.Collector.PopSide)
	next.Collector.BatchSize = PositiveOrDefault(submitted.Collector.BatchSize, next.Collector.BatchSize, 100)
	next.Collector.PollIntervalMS = PositiveOrDefault(submitted.Collector.PollIntervalMS, next.Collector.PollIntervalMS, 500)
	next.Collector.QueryLimit = PositiveOrDefault(submitted.Collector.QueryLimit, next.Collector.QueryLimit, 50000)
	next.Collector.TLSSkipVerify = submitted.Collector.TLSSkipVerify

	next.CodexInspection = store.NormalizeCodexInspectionConfig(submitted.CodexInspection, next.CodexInspection)

	next.ExternalUsageService.Enabled = false
	next.ExternalUsageService.ServiceBase = ""

	if submitted.CustomQuota.Bindings != nil {
		next.CustomQuota.Bindings = mergeCustomQuotaBindings(next.CustomQuota.Bindings, submitted.CustomQuota.Bindings)
	}

	return next
}


func mergeCustomQuotaBindings(base map[string]store.ManagerCustomQuotaBinding, submitted map[string]store.ManagerCustomQuotaBinding) map[string]store.ManagerCustomQuotaBinding {
	merged := make(map[string]store.ManagerCustomQuotaBinding, len(submitted))
	for key, incoming := range submitted {
		binding := normalizeCustomQuotaBinding(incoming)
		if previous, ok := base[key]; ok {
			if binding.QuotaAPIKey == "" {
				binding.QuotaAPIKey = previous.QuotaAPIKey
			}
			if binding.Enabled == nil {
				binding.Enabled = previous.Enabled
			}
			if previous.QuotaAPIKey != "" {
				binding.QuotaAPIKeyConfigured = true
			}
			binding.Headers = mergeCustomQuotaHeaders(previous.Headers, binding.Headers)
		}
		if binding.QuotaAPIKey != "" {
			binding.QuotaAPIKeyConfigured = true
		}
		merged[key] = binding
	}
	return merged
}

func normalizeCustomQuotaBinding(binding store.ManagerCustomQuotaBinding) store.ManagerCustomQuotaBinding {
	binding.Kind = strings.ToLower(strings.TrimSpace(binding.Kind))
	binding.URL = strings.TrimSpace(binding.URL)
	binding.AuthMode = strings.ToLower(strings.TrimSpace(binding.AuthMode))
	binding.QuotaAPIKey = strings.TrimSpace(binding.QuotaAPIKey)
	binding.APIKeyHeader = strings.TrimSpace(binding.APIKeyHeader)
	binding.ProxyURL = strings.TrimSpace(binding.ProxyURL)
	binding.ProviderName = strings.TrimSpace(binding.ProviderName)
	binding.APIKeyHash = strings.TrimSpace(binding.APIKeyHash)
	binding.Headers = cloneStringMap(binding.Headers)
	binding.Mapping = cloneStringMap(binding.Mapping)
	return binding
}

func cloneStringMap(values map[string]string) map[string]string {
	if values == nil {
		return nil
	}
	cloned := make(map[string]string, len(values))
	for key, value := range values {
		cloned[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	return cloned
}

func isSensitiveCustomQuotaHeader(name string) bool {
	normalized := strings.ToLower(strings.NewReplacer("-", "", "_", "").Replace(strings.TrimSpace(name)))
	for _, token := range []string{"authorization", "auth", "key", "token", "secret", "password", "credential", "cookie"} {
		if strings.Contains(normalized, token) {
			return true
		}
	}
	return false
}

func redactCustomQuotaHeaders(headers map[string]string) map[string]string {
	if headers == nil {
		return nil
	}
	redacted := make(map[string]string, len(headers))
	for name, value := range headers {
		if isSensitiveCustomQuotaHeader(name) && strings.TrimSpace(value) != "" {
			redacted[name] = ""
			continue
		}
		redacted[name] = value
	}
	return redacted
}

func mergeCustomQuotaHeaders(base map[string]string, submitted map[string]string) map[string]string {
	if submitted == nil {
		return nil
	}
	merged := make(map[string]string, len(submitted))
	for name, value := range submitted {
		if strings.TrimSpace(value) == "" && isSensitiveCustomQuotaHeader(name) {
			for previousName, previousValue := range base {
				if strings.EqualFold(previousName, name) && strings.TrimSpace(previousValue) != "" {
					value = previousValue
					break
				}
			}
		}
		merged[name] = value
	}
	return merged
}

func isValidCustomQuotaHeaderName(name string) bool {
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

func validateCustomQuotaHeaderName(name string) error {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return nil
	}
	if !isValidCustomQuotaHeaderName(trimmed) {
		return errors.New("custom quota header name is invalid")
	}
	return nil
}

func SetupFromManagerConfig(cfg store.ManagerConfig) store.Setup {
	return store.Setup{
		CPAUpstreamURL: cfg.CPAConnection.CPABaseURL,
		ManagementKey:  cfg.CPAConnection.ManagementKey,
		Queue:          cfg.Collector.Queue,
		PopSide:        cfg.Collector.PopSide,
	}
}

func ManagerConfigConnectionDiffers(left store.ManagerConfig, right store.ManagerConfig) bool {
	return cpa.NormalizeBaseURL(left.CPAConnection.CPABaseURL) != cpa.NormalizeBaseURL(right.CPAConnection.CPABaseURL) ||
		left.CPAConnection.ManagementKey != right.CPAConnection.ManagementKey ||
		ManagerCollectorEnabled(left) != ManagerCollectorEnabled(right) ||
		left.Collector.CollectorMode != right.Collector.CollectorMode ||
		left.Collector.Queue != right.Collector.Queue ||
		left.Collector.PopSide != right.Collector.PopSide ||
		left.Collector.BatchSize != right.Collector.BatchSize ||
		left.Collector.PollIntervalMS != right.Collector.PollIntervalMS ||
		left.Collector.TLSSkipVerify != right.Collector.TLSSkipVerify
}

func ManagerConfigCPABindingDiffers(left store.ManagerConfig, right store.ManagerConfig) bool {
	leftBase := cpa.NormalizeBaseURL(left.CPAConnection.CPABaseURL)
	rightBase := cpa.NormalizeBaseURL(right.CPAConnection.CPABaseURL)
	if leftBase == "" || left.CPAConnection.ManagementKey == "" {
		return false
	}
	return leftBase != rightBase
}

func PositiveOrDefault(value int, fallback int, hardDefault int) int {
	if value > 0 {
		return value
	}
	if fallback > 0 {
		return fallback
	}
	return hardDefault
}

func ValueOr(value string, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func NormalizePopSide(value string, fallback string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "left", "right":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		if strings.ToLower(strings.TrimSpace(fallback)) == "left" {
			return "left"
		}
		return "right"
	}
}

func CollectorMode(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "http", "resp", "subscribe":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "auto"
	}
}

func BoolPtr(value bool) *bool {
	return &value
}

func ManagerCollectorEnabled(cfg store.ManagerConfig) bool {
	return cfg.Collector.Enabled == nil || *cfg.Collector.Enabled
}

func AuthHeaderMatches(header string, managementKey string) bool {
	header = strings.TrimSpace(header)
	if header == "" || managementKey == "" {
		return false
	}
	const prefix = "Bearer "
	if len(header) < len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return false
	}
	return strings.TrimSpace(header[len(prefix):]) == managementKey
}
