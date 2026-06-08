# RxVision — Technology Stack

> Read-only ανάλυση. Εκδόσεις από `backend/pyproject.toml`, `frontend/package.json`, compose & Dockerfiles. Ημερομηνία: 2026-06-07.

## Backend (`backend/pyproject.toml`)

> **Όλα floor-pinned (`>=`), χωρίς lockfile → μη αναπαραγώγιμα builds.**

| Dependency | Spec | Σχόλιο / Ρίσκο |
|---|---|---|
| Python | `>=3.12` (Docker `python:3.12-slim`) | Τρέχουσα, υποστηριζόμενη |
| FastAPI | `>=0.111` | Unbounded — θα ανέβει σε τελευταία 0.1xx |
| uvicorn[standard] | `>=0.30` | — |
| **motor** | `>=3.4` | ⚠️ **Deprecated upstream** (αντικαθίσταται από async PyMongo) — χρειάζεται migration plan |
| pydantic[email] | `>=2.7` | v2 |
| pydantic-settings | `>=2.3` | — |
| **python-jose[cryptography]** | `>=3.3` | ⚠️ **Σχεδόν αμελητέα συντήρηση, ιστορικό CVE** — εξέτασε μετάβαση σε PyJWT |
| argon2-cffi | `>=23.1` | Σωστή επιλογή hashing |
| redis | `>=5.0` | client |
| celery | `>=5.4` | — |
| lxml | `>=5.2` | GESY XML parsing |
| httpx | `>=0.27` | HDIKA adapter |
| **python-multipart** | `>=0.0.9` | ⚠️ Το floor είναι χαμηλό· `<0.0.18` είχε CVE (DoS) |
| hvac | `>=2.3` | Vault client |
| dev | pytest>=8, pytest-asyncio>=0.23, mypy>=1.10, ruff>=0.4, mongomock-motor>=0.0.29 | mongomock-motor **αχρησιμοποίητο** |

## Frontend (`frontend/package.json`)

| Dependency | Spec | Σχόλιο / Ρίσκο |
|---|---|---|
| Node | `node:20-alpine` | LTS (maintenance) |
| **next** | `14.2.5` (exact) | ⚠️ **Παρωχημένο** — λείπουν μεταγενέστερα 14.2.x security patches (π.χ. CVE-2025-29927 middleware bypass, fixed @ 14.2.25)· υπάρχει Next 15 |
| react / react-dom | `18.3.1` (exact) | OK |
| typescript | `^5.5.3` | — |
| @tanstack/react-query | `^5.51.0` | v5 |
| zustand | `^4.5.4` | — |
| echarts / echarts-for-react | `^5.5.1` / `^3.0.2` | — |
| tailwindcss | `^3.4.6` | v3 (v4 διαθέσιμη) |
| **next-pwa** | `^5.6.0` | ⚠️ **Ουσιαστικά μη συντηρούμενο**· δύσκολη συμβατότητα με App Router (εξ ου το χειροκίνητο SW register). Εξέτασε Serwist / `@ducanh2912/next-pwa` |
| react-hook-form / zod | `^7.52.1` / `^3.23.8` | Υποχρησιμοποιημένα (τα περισσότερα forms σε raw `useState`) |
| @tiptap/* | `^2.6.6` | RichEditor (newsletter) |
| lucide-react | `^0.460.0` | icons |

> Δεν υπάρχει testing lib, eslint config package, ή Prettier στις devDeps.

## Infra (images)

| Component | Version | Σχόλιο |
|---|---|---|
| MongoDB | `mongo:7` | Floating minor· single-node replica set `rs0` |
| Redis | `redis:7-alpine` | Floating |
| Vault | `hashicorp/vault:1.17` | ⚠️ BUSL license από 1.15· OSS εναλλακτική OpenBao |
| Caddy | `caddy:2-alpine` / custom `2.10` | Reverse proxy + TLS |
| Portainer | `portainer/portainer-ce:2.21.4` | Μόνο exact-pinned infra image |

## Συστάσεις (priority)

1. **Lockfiles + exact pins** και στα δύο stacks (`uv.lock`/`poetry.lock`, `package-lock.json`) → αναπαραγώγιμα builds. *(αλλαγή κώδικα — θα ζητηθεί έγκριση)*
2. **Αναβάθμιση Next → ≥14.2.25** (ή 15.x) για τα γνωστά CVEs.
3. **Αντικατάσταση `python-jose` → PyJWT**.
4. **Migration plan για Motor → async PyMongo** (deprecation).
5. **Ανέβασμα floor `python-multipart` ≥0.0.18**.
6. **Αντικατάσταση/αναβάθμιση `next-pwa`** (Serwist).
