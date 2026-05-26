# Telemetria API

Backend NestJS de leitura para o schema PostgreSQL `trucks`.

Por padrao ele carrega variaveis de ambiente nesta ordem:

1. `.env` dentro de `telemetria_api`
2. `../telemetria_dados/.env`
3. variaveis ja exportadas no sistema

## Rodar

```bash
npm install
npm run start:dev
```

URL padrao: `http://127.0.0.1:3333`

## Endpoints

- `GET /health`
- `GET /api/vehicles`
- `GET /api/vehicles/:plate`
- `GET /api/vehicles/:plate/timeline`
- `GET /api/alerts`
- `GET /api/dashboard`
- `GET /api/reports/summary`
- `GET /api/integration`
