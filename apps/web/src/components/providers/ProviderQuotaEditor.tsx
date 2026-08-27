import { useTranslation } from 'react-i18next';
import { HeaderInputList } from '@/components/ui/HeaderInputList';
import { Select } from '@/components/ui/Select';
import type { ProviderQuotaFormState } from './types';
import styles from '@/features/aiProviders/AiProvidersPage.module.scss';
import { CUSTOM_QUOTA_MAPPING_FIELDS } from '@/utils/quota/providerQuota';

interface ProviderQuotaEditorProps {
  quota: ProviderQuotaFormState;
  onChange: (patch: Partial<ProviderQuotaFormState>) => void;
  disabled?: boolean;
}

const typeOptions = [
  { value: 'sub2api', label: 'Sub2API' },
  { value: 'custom_get', label: 'Custom GET JSON' },
] as const;

const authOptions = [
  { value: 'bearer', label: 'Bearer' },
  { value: 'header', label: 'Header' },
  { value: 'none', label: 'None' },
] as const;

export function ProviderQuotaEditor({ quota, onChange, disabled = false }: ProviderQuotaEditorProps) {
  const { t } = useTranslation();
  const isDisabled = disabled;
  const isSub2API = quota.kind === 'sub2api';
  const credentialConfigured = isSub2API
    ? Boolean(
        quota.username.trim() &&
          (quota.password.trim() ||
            quota.passwordConfigured ||
            quota.accessTokenConfigured ||
            quota.refreshTokenConfigured ||
            quota.quotaApiKeyConfigured)
      )
    : Boolean(quota.quotaApiKeyConfigured);
  const updateMapping = (field: string, value: string) =>
    onChange({ mapping: { ...quota.mapping, [field]: value } });

  return (
    <div className={styles.keyQuotaConfig}>
      <div className={styles.keyQuotaHeader}>
        <label className={styles.keyQuotaToggle}>
          <input
            type="checkbox"
            checked={quota.enabled}
            onChange={(event) => onChange({ enabled: event.target.checked })}
            disabled={isDisabled}
          />
          <span>{t('ai_providers.openai_quota_enabled', { defaultValue: 'Enable quota lookup' })}</span>
        </label>
        <span className={styles.keyQuotaStatus}>
          {credentialConfigured
            ? t(isSub2API ? 'ai_providers.sub2api_credentials_configured' : 'ai_providers.openai_quota_key_configured', {
                defaultValue: isSub2API ? 'Sub2API credentials configured' : 'API key configured',
              })
            : t(isSub2API ? 'ai_providers.sub2api_credentials_missing' : 'ai_providers.openai_quota_key_missing', {
                defaultValue: isSub2API ? 'Sub2API credentials not configured' : 'API key not configured',
              })}
        </span>
      </div>
      {quota.enabled && (
        <>
          <div className={styles.keyQuotaFields}>
            <label className={styles.keyQuotaField}>
              <span>{t('ai_providers.openai_quota_type', { defaultValue: 'Type' })}</span>
              <Select
                value={quota.kind}
                options={typeOptions}
                onChange={(value) => onChange({ kind: value as ProviderQuotaFormState['kind'] })}
                disabled={isDisabled}
                ariaLabel={t('ai_providers.openai_quota_type', { defaultValue: 'Type' })}
                className={styles.keyQuotaSelect}
              />
            </label>
            <label className={styles.keyQuotaField}>
              <span>{t('ai_providers.openai_quota_url', { defaultValue: 'Quota URL' })}</span>
              <input
                type="url"
                value={quota.url}
                onChange={(event) => onChange({ url: event.target.value })}
                disabled={isDisabled}
                className={`input ${styles.keyQuotaInput}`}
                placeholder="https://..."
              />
            </label>
            {isSub2API ? (
              <>
                <label className={styles.keyQuotaField}>
                  <span>{t('ai_providers.sub2api_username', { defaultValue: 'Username / email' })}</span>
                  <input
                    type="text"
                    value={quota.username}
                    onChange={(event) => onChange({ username: event.target.value })}
                    disabled={isDisabled}
                    className={`input ${styles.keyQuotaInput}`}
                    autoComplete="username"
                  />
                </label>
                <label className={styles.keyQuotaField}>
                  <span>{t('ai_providers.sub2api_password', { defaultValue: 'Password' })}</span>
                  <input
                    type="password"
                    value={quota.password}
                    onChange={(event) =>
                      onChange({ password: event.target.value, passwordConfigured: false })
                    }
                    disabled={isDisabled}
                    className={`input ${styles.keyQuotaInput}`}
                    placeholder={
                      quota.passwordConfigured
                        ? t('ai_providers.sub2api_password_placeholder', {
                            defaultValue: 'Configured; enter to replace',
                          })
                        : ''
                    }
                    autoComplete="new-password"
                  />
                </label>
              </>
            ) : (
              <>
                <label className={styles.keyQuotaField}>
                  <span>{t('ai_providers.openai_quota_auth', { defaultValue: 'Authentication' })}</span>
                  <Select
                    value={quota.authMode}
                    options={authOptions}
                    onChange={(value) => onChange({ authMode: value as ProviderQuotaFormState['authMode'] })}
                    disabled={isDisabled}
                    ariaLabel={t('ai_providers.openai_quota_auth', { defaultValue: 'Authentication' })}
                    className={styles.keyQuotaSelect}
                  />
                </label>
                {quota.authMode === 'header' && (
                  <label className={styles.keyQuotaField}>
                    <span>{t('ai_providers.openai_quota_auth_header', { defaultValue: 'API key header' })}</span>
                    <input
                      type="text"
                      value={quota.apiKeyHeader}
                      onChange={(event) => onChange({ apiKeyHeader: event.target.value })}
                      disabled={isDisabled}
                      className={`input ${styles.keyQuotaInput}`}
                      placeholder="X-API-Key"
                    />
                  </label>
                )}
                {quota.authMode !== 'none' && (
                  <label className={styles.keyQuotaField}>
                    <span>{t('ai_providers.openai_quota_api_key', { defaultValue: 'Quota API key' })}</span>
                    <input
                      type="password"
                      value={quota.quotaApiKey}
                      onChange={(event) =>
                        onChange({ quotaApiKey: event.target.value, quotaApiKeyConfigured: false })
                      }
                      disabled={isDisabled}
                      className={`input ${styles.keyQuotaInput}`}
                      placeholder={
                        quota.quotaApiKeyConfigured
                          ? t('ai_providers.openai_quota_key_placeholder', {
                              defaultValue: 'Configured; enter to replace',
                            })
                          : 'sk-...'
                      }
                      autoComplete="new-password"
                    />
                  </label>
                )}
              </>
            )}
            <label className={styles.keyQuotaField}>
              <span>{t('common.proxy_url')}</span>
              <input
                type="url"
                value={quota.proxyUrl}
                onChange={(event) => onChange({ proxyUrl: event.target.value })}
                disabled={isDisabled}
                className={`input ${styles.keyQuotaInput}`}
                placeholder="http://proxy:8080"
              />
            </label>
          </div>
          <HeaderInputList
            entries={quota.headers}
            onChange={(headers) => onChange({ headers })}
            addLabel={t('common.custom_headers_add')}
            keyPlaceholder={t('common.custom_headers_key_placeholder')}
            valuePlaceholder={t('common.custom_headers_value_placeholder')}
            removeButtonTitle={t('common.delete')}
            removeButtonAriaLabel={t('common.delete')}
            disabled={isDisabled}
          />
          {quota.kind === 'custom_get' && (
            <div className={styles.keyQuotaMapping}>
              <div className={styles.keyQuotaMappingTitle}>
                {t('ai_providers.openai_quota_mapping', { defaultValue: 'JSON field paths' })}
              </div>
              <div className={styles.keyQuotaFields}>
                {CUSTOM_QUOTA_MAPPING_FIELDS.map(([field, label]) => (
                  <label key={field} className={styles.keyQuotaField}>
                    <span>{label}</span>
                    <input
                      type="text"
                      value={quota.mapping[field] ?? ''}
                      onChange={(event) => updateMapping(field, event.target.value)}
                      disabled={isDisabled}
                      className={`input ${styles.keyQuotaInput}`}
                      placeholder={`$.${field}`}
                    />
                  </label>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
