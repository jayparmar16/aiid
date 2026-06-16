# Copy this file to scripts/set-r2-env.ps1 and fill in real values.
# The real file is gitignored so secrets won't be committed.

# Cloudflare R2 (S3-compatible)
$env:CLOUDFLARE_R2_ACCOUNT_ID = "<your-cloudflare-account-id>"
$env:CLOUDFLARE_R2_BUCKET_NAME = "<your-r2-bucket-name>"

# Create an R2 API token / access key pair with write access to the bucket.
$env:CLOUDFLARE_R2_WRITE_ACCESS_KEY_ID = "<your-r2-access-key-id>"
$env:CLOUDFLARE_R2_WRITE_SECRET_ACCESS_KEY = "<your-r2-secret-access-key>"

Write-Host "R2 env vars loaded for this PowerShell session."