#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p secrets public/.well-known/appspecific
if [ -e secrets/private-key.pem ]; then echo 'Existing private key preserved; refusing rotation.'; exit 1; fi
openssl ecparam -name prime256v1 -genkey -noout -out secrets/private-key.pem
openssl ec -in secrets/private-key.pem -pubout -out public/.well-known/appspecific/com.tesla.3p.public-key.pem
chmod 600 secrets/private-key.pem
chmod 644 public/.well-known/appspecific/com.tesla.3p.public-key.pem
openssl ec -in secrets/private-key.pem -pubout 2>/dev/null | cmp - public/.well-known/appspecific/com.tesla.3p.public-key.pem
printf 'Key generated and verified. Private key stays local in secrets/.\n'
