#!/usr/bin/env bash
# Create a private CA and a server certificate for the Fleet Telemetry hostname.
# Vehicles validate the server against the CA, which is sent to Tesla in each
# vehicle's fleet_telemetry_config. Usage: scripts/generate-telemetry-certs.sh telemetry.example.com
set -euo pipefail
cd "$(dirname "$0")/.."
host="${1:?usage: $0 <telemetry hostname>}"
[[ "$host" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Invalid hostname"; exit 1; }
umask 077
dir=secrets/telemetry
mkdir -p "$dir"
if [ -e "$dir/ca.key" ]; then echo "Existing telemetry CA preserved in $dir; refusing to replace it."; exit 1; fi
openssl ecparam -name prime256v1 -genkey -noout -out "$dir/ca.key"
openssl req -x509 -new -key "$dir/ca.key" -sha256 -days 3650 -subj "/CN=teslabot telemetry CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -out "$dir/ca.pem"
openssl ecparam -name prime256v1 -genkey -noout -out "$dir/server.key"
openssl req -new -key "$dir/server.key" -subj "/CN=$host" -out "$dir/server.csr"
printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:%s\n' "$host" > "$dir/server.ext"
openssl x509 -req -in "$dir/server.csr" -CA "$dir/ca.pem" -CAkey "$dir/ca.key" -CAcreateserial \
  -days 825 -sha256 -extfile "$dir/server.ext" -out "$dir/server.pem" 2>/dev/null
cat "$dir/server.pem" "$dir/ca.pem" > "$dir/server-chain.pem"
rm -f "$dir/server.csr" "$dir/server.ext" "$dir/ca.srl"
openssl verify -CAfile "$dir/ca.pem" -verify_hostname "$host" "$dir/server.pem" >/dev/null
printf 'Created %s: ca.pem (TELEMETRY_CA), server-chain.pem (TLS_CERT), server.key (TLS_KEY).\nKeep ca.key offline; it is only needed to issue a new server certificate.\n' "$dir"
