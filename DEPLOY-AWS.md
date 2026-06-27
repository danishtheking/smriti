# Deploying Smriti on AWS App Runner

Smriti is a stateless Node/Express server (no database — user data lives in the browser).
App Runner builds and runs it straight from this repo using [`apprunner.yaml`](apprunner.yaml);
HTTPS, the public URL, and autoscaling are managed for you. No Dockerfile required.

> The realtime voice WebSocket goes **browser → AssemblyAI directly** — your server only mints
> a short-lived token over HTTP — so App Runner needs no WebSocket/sticky-session support.

## What you need
- An AWS account.
- The two API keys: `ANTHROPIC_API_KEY` and `ASSEMBLYAI_API_KEY` (kept server-side; never shipped to the browser).
- This repo on GitHub: `danishtheking/smriti`.

---

## Option A — AWS Console (easiest)

1. **App Runner → Create service.**
2. **Source:** *Source code repository* → connect GitHub (`Add new` connection, authorize) → pick `danishtheking/smriti`, branch `main`. Deployment trigger: *Automatic* (redeploys on push).
3. **Build settings:** *Use a configuration file* (it picks up `apprunner.yaml`). Nothing to type.
4. **Service settings:**
   - CPU/Memory: smallest (e.g. **0.25 vCPU / 0.5 GB**) is plenty for a demo.
   - **Port:** `8080` (matches `apprunner.yaml`).
   - **Environment variables** → add:
     - `ANTHROPIC_API_KEY` = your Claude key
     - `ASSEMBLYAI_API_KEY` = your AssemblyAI key
     - *(optional)* leave `ANTHROPIC_MODEL` unset so the server routes Haiku/Sonnet per task.
   - **Health check:** Protocol **HTTP**, Path **`/api/health`**.
   - *(optional, recommended for a demo)* Auto scaling: set **min = max = 1** instance so the in-memory rate-limit is global and cost is predictable.
5. **Create & deploy.** In ~3–5 min you get a URL like `https://xxxx.<region>.awsapprunner.com`. Open it — Smriti is live.

---

## Option B — AWS CLI

```bash
# 1) (recommended) store secrets in Secrets Manager
aws secretsmanager create-secret --name smriti/anthropic  --secret-string "$ANTHROPIC_API_KEY"
aws secretsmanager create-secret --name smriti/assemblyai --secret-string "$ASSEMBLYAI_API_KEY"

# 2) create a GitHub connection (one-time), then finish authorizing it in the console
aws apprunner create-connection --connection-name smriti-gh --provider-type GITHUB

# 3) create the service from source (uses apprunner.yaml in the repo)
aws apprunner create-service \
  --service-name smriti \
  --source-configuration '{
    "AutoDeploymentsEnabled": true,
    "AuthenticationConfiguration": {"ConnectionArn": "<CONNECTION_ARN_FROM_STEP_2>"},
    "CodeRepository": {
      "RepositoryUrl": "https://github.com/danishtheking/smriti",
      "SourceCodeVersion": {"Type": "BRANCH", "Value": "main"},
      "CodeConfiguration": {"ConfigurationSource": "REPOSITORY"}
    }
  }' \
  --health-check-configuration '{"Protocol":"HTTP","Path":"/api/health"}' \
  --instance-configuration '{"Cpu":"256","Memory":"512"}'
```

Then add the env vars / secret refs to the service (Console → your service → *Configuration → Edit*), or include a `secrets:` block in `apprunner.yaml` pointing at the Secrets Manager ARNs and redeploy.

---

## Notes & gotchas
- **Secrets:** prefer **Secrets Manager** over plaintext env vars for the two API keys. App Runner injects them at runtime; they never touch the repo (`.env` is git-ignored).
- **Outbound calls:** App Runner has internet egress by default, so calls to `api.anthropic.com` and `agents.assemblyai.com` work with no VPC config.
- **Rate limiting:** `express-rate-limit` is in-memory (per instance). With autoscaling the effective limit is `max × instances`. For strict global limits, pin **1 instance** or move the limiter to a shared store.
- **Cost:** App Runner bills for the provisioned container + active requests — a few USD/month at the smallest size. Pause or delete the service when you're done demoing to stop charges.
- **Custom domain / scaling:** add a custom domain and tune autoscaling in the service settings any time.

## Cheaper-at-idle alternative
If you want scale-to-zero (near-free when unused), the serverless route is **Lambda + API Gateway** (Express via the Lambda Web Adapter, static SPA on S3/CloudFront, throttling at API Gateway). More setup than App Runner — ask and I'll wire it up.
