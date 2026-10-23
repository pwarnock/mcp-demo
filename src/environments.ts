export type EnvironmentName = 'dev' | 'staging' | 'production';

/** Service name to deployed version, per environment. */
export type Environments = Record<EnvironmentName, Record<string, string>>;

export const SEED_ENVIRONMENTS: Environments = {
  dev: { web: '1.4.0', api: '1.4.0' },
  staging: { web: '1.3.2', api: '1.3.2' },
  production: { web: '1.3.0', api: '1.3.0' },
};

export const SERVICE_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
