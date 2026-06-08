# RxVision — Execution Roadmap

> CONFIDENTIAL. Production-readiness roadmap from the 2026-06-07 audit. Organized into 4
> phases. Effort: S ≈ <2h · M ≈ ½–1d · L ≈ multi-day. "Done✓" = implemented this session
> (static-checked, awaiting live validation). All future code work needs approval.

## Phase 1 — Stabilize & verify (make it safe and provable)
| Task | Priority | Effort | Dependencies | Expected impact |
|---|---|---|---|---|
| Push `quick-wins`; CI green (pytest+ruff) | Critical | S | CI exists✓ | Proves T-01/04/05 + invariants |
| Live `docker compose up` validation of #7/#8 + auth | Critical | M | Docker host | Confirms DB auth, Vault TLS, login/refresh/admin |
| Quick wins #1–#10 | High | — | — | Done✓ |
| T-01 Vault mandatory in prod (C2) | High | — | — | Done✓ |
| T-04 JWT key/audience separation (H1) | High | — | — | Done✓ |
| T-05 rate limiting + MFA verify (M6) | High | — | — | Done✓ |
| #7/#8 Mongo/Redis auth + Vault TLS (H4/H6) | High | — | — | Done✓ |
| T-07 public-TLS hardening | High | — | — | Done✓ |
| Add lockfiles (uv/poetry, npm); `npm ci`/locked pip | High | M | — | Reproducible builds; supply-chain safety |
| Enable public TLS on server (DNS-01) | High | S | server `.env` token | Trusted HTTPS for app/admin |

## Phase 2 — Data correctness & core completeness (trustworthy product)
| Task | Priority | Effort | Dependencies | Expected impact |
|---|---|---|---|---|
| **T-06** wire wholesale pricing (`hdika_client.py:274`) | Critical | M | ΗΔΙΚΑ masterdata | Fixes profitability/margins for real ΗΔΙΚΑ tenants (currently wrong) |
| Verify ΗΔΙΚΑ `repeat_total/current` mapping vs real spec | High | M | ΗΔΙΚΑ spec | Correct future-prescription generation |
| End-to-end tests for `IngestionEngine` | High | M | — | Protects the most critical, untested path |
| Integration tests (FastAPI TestClient: auth/RBAC/isolation) | High | M | — | Real regression safety net |
| Implement data retention/erasure worker (GDPR) | High | M | — | Legal compliance; closes a stub |
| Implement profitability snapshots worker | Medium | M | — | Performance + correct by_dimension analytics |
| Make ingestion item-replace transactional (Mongo session) | Medium | S | rs0✓ | No partial-write corruption |
| Move blocking ΗΔΙΚΑ sync off the event loop | Medium | M | — | API responsiveness during backfills |

## Phase 3 — Responsive, UX & hardening (production polish)
| Task | Priority | Effort | Dependencies | Expected impact |
|---|---|---|---|---|
| Responsive/UX Phase A (QueryState, Modal, DataTable mobile/keyboard, max-width) | High | M | — | Lifts responsive ~62→85, UX ~64→80; fixes silent-error UX |
| Responsive/UX Phase B (filters, chart legibility, KPI grids, touch targets) | High | M | Phase A | Usable analytics on phones/tablets |
| Remove dead UI + branded 404/error pages + mount InstallButton | High | S | — | Removes broken/fake affordances |
| Stop leaking `JSON.stringify(problem)`; friendly errors | Medium | S | — | Professional UX, no payload leak |
| SSRF allow-list on ΗΔΙΚΑ `base_url` (M2) | Medium | S | — | Blocks internal-network probing |
| Audit logging for PHI reads + failed logins; WORM store (M5) | Medium | M | — | GDPR accountability |
| Tenant data export (GDPR portability) | Medium | M | — | Compliance; closes stub |
| T-09 random per-tenant pepper at creation | Medium | M | test | Stronger pseudonym isolation |
| Dependency upgrades (Next ≥14.2.25, python-jose→PyJWT, multipart floor) | Medium | M | lockfiles | Closes known CVEs |
| Responsive/UX Phase C/D (toasts, color tokens, contrast, a11y, breadcrumbs) | Medium | M–L | — | Brand coherence + WCAG AA |

## Phase 4 — Scale & productization
| Task | Priority | Effort | Dependencies | Expected impact |
|---|---|---|---|---|
| Split `admin.py` (1.164 LOC) into routers + services | Medium | L | tests | Maintainability |
| Real billing (payment provider) + myDATA invoicing | High | L | provider | Revenue + compliance |
| GESY (Cyprus) ingestion automation | Medium | L | ΓΕΣΥ spec | CY market |
| Observability (logs/metrics/Sentry) + healthchecks on all services | High | M | — | Operability/alerting |
| Mongo HA / backup-restore drills (PITR, offsite, encryption) | High | M | — | DR readiness |
| T-08 full MFA enrollment flow (secret/QR/recovery) | Medium | M | T-05✓ | Self-serve 2FA |
| Motor→async PyMongo migration; replace next-pwa (Serwist) | Low | M | — | Avoid deprecated deps |
| Kubernetes migration (Phase 2 in docs) | Low | L | — | Horizontal scale |

## Sequencing notes
- Phase 1 first — do not build on unverified changes. The Docker validation gate unblocks confidence in everything done this session.
- T-06 (Phase 2) is the highest *product-correctness* risk: analytics are wrong on real data until fixed.
- Responsive Phase A/B are cheap and high-visibility — good to interleave once Phase 1 is green.
