.PHONY: up down smoke logs

up:
	docker compose up --build -d

down:
	docker compose down

smoke:
	./scripts/smoke-test.sh

logs:
	docker compose logs -f --tail=50
