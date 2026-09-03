package managerconfig

import (
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

func TestPublicManagerConfigRedactsCustomQuotaSecrets(t *testing.T) {
	cfg := store.ManagerConfig{
		CustomQuota: store.ManagerCustomQuotaConfig{
			Bindings: map[string]store.ManagerCustomQuotaBinding{
				"binding": {
					Kind:                   "custom_get",
					URL:                    "https://quota.example.com/usage",
					QuotaAPIKey:            "quota-secret",
					Username:               "user@example.test",
					Password:               "configured-password",
					AccessToken:            "access-token",
					RefreshToken:           "refresh-token",
					AccessTokenExpiresAtMS: 12345,
					Headers:                map[string]string{"Authorization": "header-secret", "X-Client": "manager"},
				},
			},
		},
	}

	public := PublicConfig(cfg)
	binding := public.CustomQuota.Bindings["binding"]
	if binding.QuotaAPIKey != "" || !binding.QuotaAPIKeyConfigured {
		t.Fatalf("quota API key was not redacted: %#v", binding)
	}
	if binding.Headers["Authorization"] != "" {
		t.Fatalf("authorization header was not redacted: %#v", binding.Headers)
	}
	if binding.Headers["X-Client"] != "manager" {
		t.Fatalf("non-sensitive header changed: %#v", binding.Headers)
	}
	if binding.Password != "" || binding.AccessToken != "" || binding.RefreshToken != "" || binding.AccessTokenExpiresAtMS != 0 {
		t.Fatal("Sub2API authentication secrets were not redacted")
	}
	if !binding.PasswordConfigured || !binding.AccessTokenConfigured || !binding.RefreshTokenConfigured {
		t.Fatal("configured flags were not preserved after redaction")
	}
	if binding.Username != "user@example.test" {
		t.Fatal("Sub2API username was not preserved for editing")
	}
	if cfg.CustomQuota.Bindings["binding"].QuotaAPIKey != "quota-secret" {
		t.Fatal("public config redaction mutated the stored config")
	}
}

func TestMergeCustomQuotaBindingsPreservesRedactedSensitiveHeaders(t *testing.T) {
	base := map[string]store.ManagerCustomQuotaBinding{
		"binding": {
			Kind:        "custom_get",
			URL:         "https://quota.example.com/usage",
			Headers:     map[string]string{"Authorization": "header-secret", "X-Client": "manager"},
			QuotaAPIKey: "quota-secret",
		},
	}
	submitted := map[string]store.ManagerCustomQuotaBinding{
		"binding": {
			Kind:    "custom_get",
			URL:     "https://quota.example.com/usage",
			Headers: map[string]string{"authorization": "", "X-Client": "updated"},
		},
	}

	merged := mergeCustomQuotaBindings(base, submitted)["binding"]
	if merged.Headers["authorization"] != "header-secret" {
		t.Fatalf("redacted authorization header was not preserved: %#v", merged.Headers)
	}
	if merged.Headers["X-Client"] != "updated" {
		t.Fatalf("submitted non-sensitive header was not applied: %#v", merged.Headers)
	}
	if merged.QuotaAPIKey != "quota-secret" {
		t.Fatal("quota API key was not preserved")
	}
}

func TestMergeCustomQuotaBindingsPreservesAndClearsSub2APICredentials(t *testing.T) {
	base := map[string]store.ManagerCustomQuotaBinding{
		"binding": {
			Kind:                   "sub2api",
			URL:                    "https://sub2api.example.test",
			Username:               "old@example.test",
			Password:               "old-password",
			AccessToken:            "old-access",
			RefreshToken:           "old-refresh",
			AccessTokenExpiresAtMS: 12345,
		},
	}

	preserved := mergeCustomQuotaBindings(base, map[string]store.ManagerCustomQuotaBinding{
		"binding": {Kind: "sub2api", URL: "https://sub2api.example.test"},
	})["binding"]
	if preserved.Username != "old@example.test" || preserved.Password != "old-password" || preserved.AccessToken != "old-access" || preserved.RefreshToken != "old-refresh" {
		t.Fatal("existing Sub2API credentials were not preserved")
	}
	if !preserved.PasswordConfigured || !preserved.AccessTokenConfigured || !preserved.RefreshTokenConfigured {
		t.Fatal("preserved Sub2API credentials did not derive configured flags")
	}

	replaced := mergeCustomQuotaBindings(base, map[string]store.ManagerCustomQuotaBinding{
		"binding": {Kind: "sub2api", URL: "https://sub2api.example.test", Username: "new@example.test"},
	})["binding"]
	if replaced.Username != "new@example.test" || replaced.Password != "old-password" {
		t.Fatal("updated Sub2API username did not preserve the password")
	}
	if replaced.AccessToken != "" || replaced.RefreshToken != "" || replaced.AccessTokenExpiresAtMS != 0 {
		t.Fatal("changing the Sub2API username did not clear cached tokens")
	}
	if replaced.AccessTokenConfigured || replaced.RefreshTokenConfigured {
		t.Fatal("cleared Sub2API tokens retained configured flags")
	}
}

func TestValidateCustomQuotaConfigRejectsInvalidHeaderName(t *testing.T) {
	err := ValidateCustomQuotaConfig(store.ManagerCustomQuotaConfig{
		Bindings: map[string]store.ManagerCustomQuotaBinding{
			"binding": {
				Kind:    "custom_get",
				URL:     "https://quota.example.com/usage",
				Headers: map[string]string{"X-Test\r\nInjected": "value"},
			},
		},
	})
	if err == nil {
		t.Fatal("expected invalid custom quota header name to fail validation")
	}
}

func TestValidateCustomQuotaConfigRejectsInvalidProxyAndQuotaKey(t *testing.T) {
	cases := []struct {
		name    string
		binding store.ManagerCustomQuotaBinding
	}{
		{
			name: "proxy scheme",
			binding: store.ManagerCustomQuotaBinding{
					Kind:     "custom_get",
					URL:      "https://quota.example.com/usage",
					ProxyURL: "ftp://proxy.example.com",
			},
		},
		{
			name: "quota key newline",
			binding: store.ManagerCustomQuotaBinding{
					Kind:        "custom_get",
					URL:         "https://quota.example.com/usage",
					QuotaAPIKey: "quota\r\nsecret",
			},
		},
		{
			name: "header token",
			binding: store.ManagerCustomQuotaBinding{
				Kind:    "custom_get",
				URL:     "https://quota.example.com/usage",
				Headers: map[string]string{"X Invalid": "value"},
			},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			err := ValidateCustomQuotaConfig(store.ManagerCustomQuotaConfig{
				Bindings: map[string]store.ManagerCustomQuotaBinding{"binding": testCase.binding},
			})
			if err == nil {
				t.Fatal("expected invalid custom quota binding to fail validation")
			}
		})
	}
}
func TestResolveLegacyConnectionAuthorityMatrix(t *testing.T) {
	const (
		urlA = "http://cpa-a.local:8317"
		urlB = "http://cpa-b.local:8317"
		key  = "key-a"
	)
	tests := []struct {
		name          string
		managerOK     bool
		managerURL    string
		managerKey    string
		setupOK       bool
		setupURL      string
		setupKey      string
		wantAuthority LegacyConnectionAuthority
		wantURL       string
		wantKey       string
		wantErr       bool
	}{
		{
			name:          "complete manager wins over conflicting setup",
			managerOK:     true,
			managerURL:    urlA,
			managerKey:    key,
			setupOK:       true,
			setupURL:      urlB,
			setupKey:      "key-b",
			wantAuthority: LegacyConnectionAuthorityManager,
			wantURL:       urlA,
			wantKey:       key,
		},
		{
			name:          "matching setup repairs manager URL partial",
			managerOK:     true,
			managerURL:    urlA,
			setupOK:       true,
			setupURL:      urlA,
			setupKey:      key,
			wantAuthority: LegacyConnectionAuthoritySetup,
			wantURL:       urlA,
			wantKey:       key,
		},
		{
			name:       "setup URL conflicts with manager URL partial",
			managerOK:  true,
			managerURL: urlA,
			setupOK:    true,
			setupURL:   urlB,
			setupKey:   key,
			wantErr:    true,
		},
		{
			name:          "matching setup repairs manager key partial",
			managerOK:     true,
			managerKey:    key,
			setupOK:       true,
			setupURL:      urlA,
			setupKey:      key,
			wantAuthority: LegacyConnectionAuthoritySetup,
			wantURL:       urlA,
			wantKey:       key,
		},
		{
			name:       "setup key conflicts with manager key partial",
			managerOK:  true,
			managerKey: "key-manager",
			setupOK:    true,
			setupURL:   urlA,
			setupKey:   "key-setup",
			wantErr:    true,
		},
		{
			name:          "setup is authority when manager is missing",
			setupOK:       true,
			setupURL:      urlA,
			setupKey:      key,
			wantAuthority: LegacyConnectionAuthoritySetup,
			wantURL:       urlA,
			wantKey:       key,
		},
		{
			name:          "partial rows are not combined from manager URL and setup key",
			managerOK:     true,
			managerURL:    urlA,
			setupOK:       true,
			setupKey:      key,
			wantAuthority: LegacyConnectionAuthorityNone,
		},
		{
			name:          "partial rows are not combined from manager key and setup URL",
			managerOK:     true,
			managerKey:    key,
			setupOK:       true,
			setupURL:      urlA,
			wantAuthority: LegacyConnectionAuthorityNone,
		},
		{
			name:       "overlapping partial URLs conflict",
			managerOK:  true,
			managerURL: urlA,
			setupOK:    true,
			setupURL:   urlB,
			wantErr:    true,
		},
		{
			name:       "overlapping partial keys conflict",
			managerOK:  true,
			managerKey: "key-manager",
			setupOK:    true,
			setupKey:   "key-setup",
			wantErr:    true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resolution, err := ResolveLegacyConnectionAuthority(
				store.ManagerConfig{CPAConnection: store.ManagerCPAConnectionConfig{
					CPABaseURL:    tt.managerURL,
					ManagementKey: tt.managerKey,
				}},
				tt.managerOK,
				store.Setup{CPAUpstreamURL: tt.setupURL, ManagementKey: tt.setupKey},
				tt.setupOK,
			)
			if (err != nil) != tt.wantErr {
				t.Fatalf("error = %v, wantErr=%v", err, tt.wantErr)
			}
			if tt.wantErr {
				return
			}
			if resolution.Authority != tt.wantAuthority {
				t.Fatalf("authority = %q, want %q", resolution.Authority, tt.wantAuthority)
			}
			if resolution.Connection.BaseURL != tt.wantURL || resolution.Connection.ManagementKey != tt.wantKey {
				t.Fatalf("connection = %#v, want URL=%q key=%q", resolution.Connection, tt.wantURL, tt.wantKey)
			}
		})
	}
}

func TestMergeCustomQuotaBindingsDerivesQuotaAPIKeyConfigured(t *testing.T) {
	submitted := map[string]store.ManagerCustomQuotaBinding{
		"binding": {
			Kind:                  "custom_get",
			URL:                   "https://quota.example.com/usage",
			QuotaAPIKeyConfigured: true,
		},
	}
	merged := mergeCustomQuotaBindings(nil, submitted)["binding"]
	if merged.QuotaAPIKeyConfigured {
		t.Fatal("quota API key configured flag must not be trusted from submitted config")
	}

	submitted["binding"] = store.ManagerCustomQuotaBinding{
		Kind:        "custom_get",
		URL:         "https://quota.example.com/usage",
		QuotaAPIKey: "quota-secret",
	}
	merged = mergeCustomQuotaBindings(nil, submitted)["binding"]
	if !merged.QuotaAPIKeyConfigured {
		t.Fatal("configured quota API key was not reflected in derived flag")
	}

	base := map[string]store.ManagerCustomQuotaBinding{
		"binding": {QuotaAPIKeyConfigured: true},
	}
	merged = mergeCustomQuotaBindings(base, map[string]store.ManagerCustomQuotaBinding{
		"binding": {Kind: "custom_get", URL: "https://quota.example.com/usage"},
	})["binding"]
	if merged.QuotaAPIKeyConfigured {
		t.Fatal("legacy configured flag without a key must not be preserved")
	}
}

func TestValidateCustomQuotaConfigRejectsCredentialQueryParameter(t *testing.T) {
	cases := []struct {
		name    string
		binding store.ManagerCustomQuotaBinding
	}{
		{
			name:    "quota URL",
			binding: store.ManagerCustomQuotaBinding{Kind: "custom_get", URL: "https://quota.example.com/usage?api_key=secret"},
		},
		{
			name:    "proxy URL",
			binding: store.ManagerCustomQuotaBinding{Kind: "custom_get", URL: "https://quota.example.com/usage", ProxyURL: "http://proxy.example.com?access_token=secret"},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			err := ValidateCustomQuotaConfig(store.ManagerCustomQuotaConfig{
				Bindings: map[string]store.ManagerCustomQuotaBinding{"binding": testCase.binding},
			})
			if err == nil {
				t.Fatal("expected credential query parameter to fail validation")
			}
		})
	}

	if err := ValidateCustomQuotaConfig(store.ManagerCustomQuotaConfig{
		Bindings: map[string]store.ManagerCustomQuotaBinding{
			"binding": {Kind: "custom_get", URL: "https://quota.example.com/usage?account=team-a"},
		},
	}); err != nil {
		t.Fatalf("ordinary query parameter was rejected: %v", err)
	}
}
func TestLegacyConnectionResolutionValidatesRequestedInput(t *testing.T) {
	resolution, err := ResolveLegacyConnectionAuthority(
		store.ManagerConfig{CPAConnection: store.ManagerCPAConnectionConfig{CPABaseURL: "http://cpa-a.local:8317"}},
		true,
		store.Setup{ManagementKey: "key-a"},
		true,
	)
	if err != nil {
		t.Fatalf("resolve partial rows: %v", err)
	}
	if err := resolution.ValidateRequestedLegacyConnection(LegacyConnection{
		BaseURL:       "http://cpa-a.local:8317/",
		ManagementKey: "key-a",
	}); err != nil {
		t.Fatalf("matching explicit input rejected: %v", err)
	}
	if err := resolution.ValidateRequestedLegacyConnection(LegacyConnection{
		BaseURL:       "http://cpa-a.local:8317",
		ManagementKey: "key-b",
	}); err == nil {
		t.Fatal("conflicting partial key was accepted")
	}
}
