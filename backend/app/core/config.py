from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

# Sentinel value shipped in .env.example. Must never survive into a deployed
# environment — assert_production_secrets() refuses to boot if it does.
_DEV_DEFAULT_SECRET = "change-me-dev-only"
_PROD_ENVS = {"prod", "production", "staging"}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    ENV: str = "local"
    API_V1_PREFIX: str = "/api/v1"
    CORS_ORIGINS: str = "http://localhost:3000"

    MONGODB_URI: str = "mongodb://mongo:27017/?replicaSet=rs0"
    MONGODB_DB: str = "rxvision"

    # Ingestion: when a source feed (e.g. live ΗΔΥΚΑ) doesn't provide wholesale price and
    # no masterdata price is known, estimate wholesale = retail * (1 - pct/100) so margins
    # aren't computed against a 0 cost (which made gross_profit == amount_claimed). Such
    # items are flagged wholesale_source="estimated". Set to 0 to disable estimation.
    WHOLESALE_FALLBACK_MARGIN_PCT: float = 25.0
    # SSRF guard: optional comma-separated host suffixes the tenant-supplied ΗΔΥΚΑ base_url
    # must match (e.g. "e-prescription.gr"). Empty = allow any PUBLIC host (private/loopback
    # IPs are always blocked). See app/utils/net.assert_safe_outbound_url (M2).
    IDIKA_ALLOWED_HOST_SUFFIXES: str = ""

    REDIS_URL: str = "redis://redis:6379/0"
    HDIKA_MAX_CALLS_PER_SEC: int = 40    # global cap on ΗΔΥΚΑ HTTP calls/sec across ALL workers
    HDIKA_CDA_CONCURRENCY: int = 16      # parallel CDA fetches within one tenant sync (bounded)
    CELERY_BROKER_URL: str = "redis://redis:6379/1"
    CELERY_RESULT_BACKEND: str = "redis://redis:6379/2"

    JWT_SECRET: str = "change-me-dev-only"
    # Separate signing key for platform-admin tokens — cryptographic domain separation
    # from tenant tokens (a tenant token can never be replayed as a platform one). (H1)
    JWT_PLATFORM_SECRET: str = "change-me-dev-only-platform"
    # 3rd identity: patient-portal customers — own signing key, isolated from tenant/admin.
    JWT_PATIENT_SECRET: str = "change-me-dev-only-patient"
    JWT_ALG: str = "HS256"
    ACCESS_TOKEN_TTL_SECONDS: int = 900
    REFRESH_TOKEN_TTL_SECONDS: int = 60 * 60 * 24 * 30

    # Web Push (VAPID) — patient portal phone notifications. Public key is exposed to the
    # browser; private key (base64 of its PEM) signs the push. Empty ⇒ push disabled (no-op).
    VAPID_PUBLIC_KEY: str = ""
    VAPID_PRIVATE_KEY_B64: str = ""
    VAPID_SUBJECT: str = "mailto:admin@rxvision.gr"

    # In prod read from Vault, never from env files.
    ANONYMIZATION_GLOBAL_PEPPER: str = "change-me-dev-only"
    VAULT_ADDR: str = ""
    VAULT_TOKEN: str = ""
    VAULT_CACERT: str = ""  # path to Vault's CA cert (HTTPS verification)

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def idika_allowed_host_suffixes(self) -> list[str]:
        return [s.strip() for s in self.IDIKA_ALLOWED_HOST_SUFFIXES.split(",") if s.strip()]

    @property
    def is_production(self) -> bool:
        return self.ENV.strip().lower() in _PROD_ENVS

    def assert_production_secrets(self) -> None:
        """Fail fast: never boot a prod/staging environment with the dev-default
        JWT secret, anonymization pepper, or a wildcard CORS origin. Health data +
        forgeable tokens make these defaults a critical (C1) exposure."""
        if not self.is_production:
            return
        weak = [
            name
            for name, value in (
                ("JWT_SECRET", self.JWT_SECRET),
                ("JWT_PLATFORM_SECRET", self.JWT_PLATFORM_SECRET),
                ("JWT_PATIENT_SECRET", self.JWT_PATIENT_SECRET),
                ("ANONYMIZATION_GLOBAL_PEPPER", self.ANONYMIZATION_GLOBAL_PEPPER),
            )
            if _DEV_DEFAULT_SECRET in value or not value.strip()
        ]
        if "*" in self.cors_origins:
            weak.append("CORS_ORIGINS(=*)")
        # The dev DB credentials embed the sentinel (e.g. change-me-dev-only-mongo);
        # refuse to ship them to prod.
        for name, value in (("MONGODB_URI", self.MONGODB_URI),
                            ("REDIS_URL", self.REDIS_URL)):
            if _DEV_DEFAULT_SECRET in value:
                weak.append(name)
        if weak:
            raise RuntimeError(
                f"Refusing to start in ENV={self.ENV!r}: insecure default(s) for "
                f"{', '.join(weak)}. Set strong values (ideally via Vault) before deploy."
            )


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
