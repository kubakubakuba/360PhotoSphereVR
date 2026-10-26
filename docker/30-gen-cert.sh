#!/bin/sh
# Generates a self-signed certificate unless one is already present
# (e.g. mounted from ./certs, created with mkcert so the headset trusts it).
set -eu

SSL_DIR=/etc/nginx/ssl
CERT="$SSL_DIR/cert.pem"
KEY="$SSL_DIR/key.pem"

if [ -s "$CERT" ] && [ -s "$KEY" ]; then
    echo "$0: using existing certificate $CERT"
    exit 0
fi

NAME="${SERVER_NAME:-localhost}"
SAN="DNS:$NAME,IP:127.0.0.1"
if [ "$NAME" != "localhost" ]; then
    SAN="$SAN,DNS:localhost"
fi
if [ -n "${SSL_SAN:-}" ]; then
    SAN="$SAN,$SSL_SAN"
fi

mkdir -p "$SSL_DIR"
echo "$0: generating self-signed certificate for $SAN"
openssl req -x509 -nodes -newkey rsa:2048 -days "${SSL_DAYS:-825}" \
    -keyout "$KEY" -out "$CERT" \
    -subj "/CN=$NAME" \
    -addext "subjectAltName=$SAN" 2>/dev/null
