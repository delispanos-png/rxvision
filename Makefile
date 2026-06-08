# RxVision — operational shortcuts. Usage: `make <target>`
COMPOSE := docker compose -f docker-compose.prod.yml

.DEFAULT_GOAL := help
.PHONY: help up down restart ps logs build deploy seed smoke test unseal vault-tls backup shell-api psql-mongo

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

vault-tls: ## Generate the self-signed Vault TLS cert (idempotent)
	bash infra/scripts/gen-vault-tls.sh

up: vault-tls ## Start the full stack
	$(COMPOSE) up -d

down: ## Stop the stack
	$(COMPOSE) down

restart: ## Restart api + web (svc=... to target one)
	$(COMPOSE) restart $(or $(svc),api web)

ps: ## Show container status
	$(COMPOSE) ps

logs: ## Tail logs (svc=api by default)
	$(COMPOSE) logs -f $(or $(svc),api)

build: ## Rebuild images (svc=... to target one)
	$(COMPOSE) build $(or $(svc),api web)

deploy: ## Rebuild + restart api & web (code deploy)
	$(COMPOSE) build api web && $(COMPOSE) up -d api web

seed: ## (Re)seed demo tenant + data
	$(COMPOSE) run --rm -e PYTHONPATH=/app api python scripts/seed.py

smoke: ## Run full-stack smoke test
	bash scripts/smoke-test.sh

test: ## Run backend unit tests in the api image
	$(COMPOSE) run --rm --user root -v $(CURDIR)/backend:/app -e PYTHONPATH=/app api sh -c "pip install -q pytest pytest-asyncio && pytest -q tests/ -p no:cacheprovider"

unseal: ## Unseal Vault after a restart/reboot
	bash infra/scripts/vault-unseal.sh

backup: ## One-off Mongo backup now
	bash infra/scripts/mongo-backup.sh

shell-api: ## Open a shell in the api container
	$(COMPOSE) exec api sh
