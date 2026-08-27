package model

type ManagerConfig struct {
	CPAConnection        ManagerCPAConnectionConfig        `json:"cpaConnection"`
	Collector            ManagerCollectorConfig            `json:"collector"`
	CodexInspection      ManagerCodexInspectionConfig      `json:"codexInspection"`
	ExternalUsageService ManagerExternalUsageServiceConfig `json:"externalUsageService"`
	CustomQuota          ManagerCustomQuotaConfig          `json:"customQuota,omitempty"`
	UpdatedAtMS          int64                             `json:"updatedAtMs,omitempty"`
}


type ManagerCustomQuotaConfig struct {
	Bindings map[string]ManagerCustomQuotaBinding `json:"bindings,omitempty"`
}

type ManagerCustomQuotaBinding struct {
	Kind                  string            `json:"kind"`
	URL                   string            `json:"url"`
	AuthMode              string            `json:"authMode,omitempty"`
	QuotaAPIKey           string            `json:"quotaApiKey,omitempty"`
	QuotaAPIKeyConfigured bool              `json:"quotaApiKeyConfigured,omitempty"`
	APIKeyHeader          string            `json:"apiKeyHeader,omitempty"`
	Headers               map[string]string `json:"headers,omitempty"`
	ProxyURL              string            `json:"proxyUrl,omitempty"`
	Mapping               map[string]string `json:"mapping,omitempty"`
	ProviderName          string            `json:"providerName,omitempty"`
	APIKeyHash            string            `json:"apiKeyHash,omitempty"`
	Enabled               *bool             `json:"enabled,omitempty"`
}

type ManagerCPAConnectionConfig struct {
	CPABaseURL    string `json:"cpaBaseUrl"`
	ManagementKey string `json:"managementKey,omitempty"`
}

type ManagerCollectorConfig struct {
	Enabled        *bool  `json:"enabled,omitempty"`
	CollectorMode  string `json:"collectorMode,omitempty"`
	Queue          string `json:"queue,omitempty"`
	PopSide        string `json:"popSide,omitempty"`
	BatchSize      int    `json:"batchSize,omitempty"`
	PollIntervalMS int    `json:"pollIntervalMs,omitempty"`
	QueryLimit     int    `json:"queryLimit,omitempty"`
	TLSSkipVerify  bool   `json:"tlsSkipVerify,omitempty"`
}

type ManagerExternalUsageServiceConfig struct {
	Enabled     bool   `json:"enabled"`
	ServiceBase string `json:"serviceBase,omitempty"`
}
