#!/bin/sh
# Copyright (c) 2026 Chea Phearom. All rights reserved.
# Proprietary and confidential: see the LICENSE file.
#
# Makes the certificate and private key that let the POS print through QZ Tray without an "Allow?" question.
#   sh scripts/make-qz-cert.sh [folder]      (default: ./qz-keys)
# Creates qz-certificate.pem (import it in QZ Tray on every till) and qz-private-key.pem (secret), and prints the
# two lines to put in the server's .env. Keep the folder out of git and safe; anyone with the key can print.
set -eu
DIR="${1:-qz-keys}"
mkdir -p "$DIR"
umask 077
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$DIR/qz-private-key.pem" -out "$DIR/qz-certificate.pem" \
  -subj "/CN=POS printing/O=POS" >/dev/null 2>&1
oneline() { awk '{ printf "%s\\n", $0 }' "$1" | sed 's/\\n$//'; }
echo "Made $DIR/qz-certificate.pem and $DIR/qz-private-key.pem (valid 10 years)."
echo
echo "1. Put these two lines in the server's .env (deploy/.env), then restart the api:"
printf '%s\n' "QZ_CERTIFICATE=$(oneline "$DIR/qz-certificate.pem")"
printf '%s\n' "QZ_PRIVATE_KEY=$(oneline "$DIR/qz-private-key.pem")"
echo
echo "2. On every till: QZ Tray icon -> Advanced -> Site Manager -> + -> choose $DIR/qz-certificate.pem"
