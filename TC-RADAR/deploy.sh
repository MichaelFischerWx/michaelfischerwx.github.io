#!/usr/bin/env bash
# --------------------------------------------------------------------------
# TC-ATLAS API — Deploy to Google Cloud Run
# (Tropical Cyclone Analysis Tool for Live and Archived Structure)
# --------------------------------------------------------------------------
# Prerequisites:
#   1. Install gcloud CLI: https://cloud.google.com/sdk/docs/install
#   2. Authenticate:       gcloud auth login
#   3. Set project:        gcloud config set project YOUR_PROJECT_ID
#   4. Enable APIs:        gcloud services enable run.googleapis.com \
#                              artifactregistry.googleapis.com \
#                              cloudbuild.googleapis.com
#
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh                    # first deploy (will prompt for region)
#   ./deploy.sh --tag v2           # deploy with a traffic tag
#
# After first deploy, update your frontend JS files:
#   const API_BASE = 'https://tc-atlas-api-XXXXXXXXXX-ue.a.run.app';
#   (Cloud Run will print the service URL after deploy)
# --------------------------------------------------------------------------

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────
SERVICE_NAME="tc-atlas-api"
REGION="us-east1"                   # close to your S3 bucket in us-east-1
MEMORY="2Gi"                        # match your current Render plan
CPU="1"                             # 1 vCPU per instance
MAX_INSTANCES="5"                   # cost ceiling — adjust as needed
MIN_INSTANCES="0"                   # scale to zero in off-season
                                    # set to 1 during hurricane season to
                                    # avoid cold starts
CONCURRENCY="20"                    # requests per instance
TIMEOUT="300s"                      # match gunicorn timeout

# ── Deploy ────────────────────────────────────────────────────
echo "Deploying ${SERVICE_NAME} to Cloud Run (${REGION})..."

gcloud run deploy "${SERVICE_NAME}" \
    --source . \
    --region "${REGION}" \
    --platform managed \
    --memory "${MEMORY}" \
    --cpu "${CPU}" \
    --max-instances "${MAX_INSTANCES}" \
    --min-instances "${MIN_INSTANCES}" \
    --concurrency "${CONCURRENCY}" \
    --timeout "${TIMEOUT}" \
    --port 8080 \
    --allow-unauthenticated \
    --set-env-vars "TC_RADAR_S3_BUCKET=${TC_RADAR_S3_BUCKET:-}" \
    --set-env-vars "TC_RADAR_S3_PREFIX=${TC_RADAR_S3_PREFIX:-tc-radar}" \
    --set-env-vars "AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-}" \
    --set-env-vars "AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-}" \
    --set-env-vars "AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-us-east-1}" \
    --set-env-vars "^||^CORS_ORIGINS=https://michaelfischerwx.github.io,http://localhost:8000" \
    "$@"

echo ""
echo "Done! Update your frontend API_BASE to the URL above."
echo ""
echo "Useful commands:"
echo "  gcloud run services describe ${SERVICE_NAME} --region ${REGION}"
echo "  gcloud run services update ${SERVICE_NAME} --region ${REGION} --min-instances 1   # hurricane season"
echo "  gcloud run services update ${SERVICE_NAME} --region ${REGION} --min-instances 0   # off-season"
echo "  gcloud run services logs read ${SERVICE_NAME} --region ${REGION} --limit 50"
