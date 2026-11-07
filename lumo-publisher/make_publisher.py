#!/usr/bin/env python3
"""Create (or renew) your own free lumo code-signing publisher on Linux / macOS / Windows.

Same certificate profile and file names as New-LumoPublisher.ps1, so either tool can create the
publisher and either signer (Sign-Lumo.ps1 on Windows, sign.sh with osslsigncode elsewhere) can use it.

    python3 make_publisher.py --publisher "lumo"                      # new root + signing certificate
    python3 make_publisher.py --publisher "lumo" --root-pfx publisher/lumo-root-PRIVATE-backup.pfx --force
                                                                      # renewal: new signing cert, same root

Password: environment variable LUMO_SIGN_PASSWORD (or --password-env NAME), otherwise asked twice.
Needs the 'cryptography' package (pip install cryptography); nothing is downloaded at run time.
"""
from __future__ import annotations

import argparse
import datetime as dt
import getpass
import hashlib
import json
import os
import re
import sys
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

CODE_SIGNING = ExtendedKeyUsageOID.CODE_SIGNING


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "publisher"


def make_name(common_name: str, organization: str, country: str) -> x509.Name:
    attrs = [x509.NameAttribute(NameOID.COMMON_NAME, common_name)]
    if organization:
        attrs.append(x509.NameAttribute(NameOID.ORGANIZATION_NAME, organization))
    if country:
        attrs.append(x509.NameAttribute(NameOID.COUNTRY_NAME, country.upper()))
    return x509.Name(attrs)


def thumbprint(cert: x509.Certificate) -> str:
    return hashlib.sha1(cert.public_bytes(serialization.Encoding.DER)).hexdigest().upper()


def add_years(t: dt.datetime, years: int) -> dt.datetime:
    try:
        return t.replace(year=t.year + years)
    except ValueError:  # 29 February
        return t.replace(year=t.year + years, day=28)


def pfx_encryption(password: bytes, legacy: bool):
    if legacy:  # for Windows older than 10 1709 / Server 2016
        return (serialization.PrivateFormat.PKCS12.encryption_builder()
                .kdf_rounds(50000)
                .key_cert_algorithm(pkcs12.PBES.PBESv1SHA1And3KeyTripleDESCBC)
                .hmac_hash(hashes.SHA1())
                .build(password))
    return (serialization.PrivateFormat.PKCS12.encryption_builder()
            .kdf_rounds(100000)
            .key_cert_algorithm(pkcs12.PBES.PBESv2SHA256AndAES256CBC)
            .hmac_hash(hashes.SHA256())
            .build(password))


def read_password(env_name: str, prompt_twice: bool = True) -> bytes:
    v = os.environ.get(env_name)
    if v:
        if len(v) < 12:
            sys.exit(f"{env_name} is shorter than 12 characters.")
        return v.encode()
    if not sys.stdin.isatty():
        sys.exit(f"No terminal to ask for the password; set {env_name}.")
    while True:
        a = getpass.getpass("Password for the .pfx files (at least 12 characters): ")
        if not prompt_twice:
            return a.encode()
        b = getpass.getpass("Repeat the password: ")
        if a != b:
            print("The passwords differ. Try again.")
        elif len(a) < 12:
            print("Too short. Use at least 12 characters.")
        else:
            return a.encode()


def build_root(name: x509.Name, years: int, now: dt.datetime):
    key = rsa.generate_private_key(public_exponent=65537, key_size=4096)
    ski = x509.SubjectKeyIdentifier.from_public_key(key.public_key())
    cert = (x509.CertificateBuilder()
            .subject_name(name).issuer_name(name)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(days=1))
            .not_valid_after(add_years(now, years))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                                         data_encipherment=False, key_agreement=False, key_cert_sign=True,
                                         crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([CODE_SIGNING]), critical=False)
            .add_extension(ski, critical=False)
            .sign(key, hashes.SHA256()))
    return key, cert


def build_leaf(name: x509.Name, root_key, root_cert: x509.Certificate, years: int, now: dt.datetime):
    key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    not_after = min(add_years(now, years), root_cert.not_valid_after_utc - dt.timedelta(days=1))
    cert = (x509.CertificateBuilder()
            .subject_name(name).issuer_name(root_cert.subject)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(days=1))
            .not_valid_after(not_after)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                                         data_encipherment=False, key_agreement=False, key_cert_sign=False,
                                         crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([CODE_SIGNING]), critical=False)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(root_cert.public_key()), critical=False)
            .sign(root_key, hashes.SHA256()))
    return key, cert


def write_private(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--publisher", default="lumo", help="name Windows shows as the publisher (default: lumo)")
    ap.add_argument("--organization", default="")
    ap.add_argument("--country", default="", help="two-letter country code, optional")
    ap.add_argument("--out-dir", default=str(Path(__file__).resolve().parent / "publisher"))
    ap.add_argument("--root-years", type=int, default=15)
    ap.add_argument("--signing-years", type=int, default=5)
    ap.add_argument("--root-pfx", default="", help="renew: issue a new signing certificate from this root backup")
    ap.add_argument("--password-env", default="LUMO_SIGN_PASSWORD")
    ap.add_argument("--legacy-pfx", action="store_true", help="3DES/SHA1 .pfx for very old Windows versions")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    if not a.publisher.strip():
        ap.error("--publisher must not be empty")
    if a.country and not re.fullmatch(r"[A-Za-z]{2}", a.country):
        ap.error("--country must be a two-letter code")
    if not (2 <= a.root_years <= 30) or not (1 <= a.signing_years <= 10) or a.signing_years >= a.root_years:
        ap.error("need 2 <= --root-years <= 30, 1 <= --signing-years <= 10 and signing-years < root-years")

    out = Path(a.out_dir)
    slug = slugify(a.publisher)
    files = {
        "codesign_pfx": out / f"{slug}-codesign.pfx",
        "codesign_cer": out / f"{slug}-codesign.cer",
        "root_cer": out / f"{slug}-root.cer",
        "root_backup": out / f"{slug}-root-PRIVATE-backup.pfx",
        "json": out / "publisher.json",
    }
    guarded = [files["codesign_pfx"], files["codesign_cer"], files["json"]]
    if not a.root_pfx:
        guarded += [files["root_cer"], files["root_backup"]]
    existing = [str(p) for p in guarded if p.exists()]
    if existing and not a.force:
        print("A publisher already exists here:\n  " + "\n  ".join(existing) +
              "\nUse --force to replace it, or --root-pfx to renew from the existing root.", file=sys.stderr)
        return 2

    password = read_password(a.password_env)
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    enc = pfx_encryption(password, a.legacy_pfx)

    if a.root_pfx:
        root_pw = os.environ.get(a.password_env + "_ROOT", "").encode() or password
        try:
            root_key, root_cert, _ = pkcs12.load_key_and_certificates(Path(a.root_pfx).read_bytes(), root_pw)
        except ValueError as e:
            print(f"Cannot open {a.root_pfx}: {e} (wrong password?)", file=sys.stderr)
            return 2
        if root_key is None or root_cert is None or root_cert.subject != root_cert.issuer:
            print(f"{a.root_pfx} does not hold a self-signed root with its private key.", file=sys.stderr)
            return 2
        if Path(a.root_pfx).resolve() != files["root_backup"].resolve():
            write_private(files["root_backup"], Path(a.root_pfx).read_bytes())
    else:
        print(f"Creating root certificate '{a.publisher} Root CA' (RSA 4096, {a.root_years} years) ...")
        root_key, root_cert = build_root(make_name(f"{a.publisher} Root CA", a.organization, a.country), a.root_years, now)
        write_private(files["root_backup"], pkcs12.serialize_key_and_certificates(
            f"{a.publisher} Root CA".encode(), root_key, root_cert, None, enc))

    print(f"Creating code-signing certificate '{a.publisher}' (RSA 3072) ...")
    leaf_key, leaf_cert = build_leaf(make_name(a.publisher, a.organization, a.country), root_key, root_cert,
                                     a.signing_years, now)

    write_private(files["codesign_pfx"], pkcs12.serialize_key_and_certificates(
        f"{a.publisher} code signing".encode(), leaf_key, leaf_cert, None, enc))
    files["codesign_cer"].write_bytes(leaf_cert.public_bytes(serialization.Encoding.DER))
    files["root_cer"].write_bytes(root_cert.public_bytes(serialization.Encoding.DER))

    def rfc4514_windows(name: x509.Name) -> str:  # Windows lists RDNs leaf-first: "CN=..., O=..., C=..."
        def q(v: str) -> str:
            return '"' + v.replace('"', '""') + '"' if re.search(r'[,+"\\<>;=#]', v) or v != v.strip() else v
        return ", ".join(f"{attr.rfc4514_attribute_name}={q(attr.value)}" for attr in name)

    info = {
        "publisher": a.publisher,
        "subject": rfc4514_windows(leaf_cert.subject),
        "signing_thumbprint": thumbprint(leaf_cert),
        "signing_not_after": leaf_cert.not_valid_after_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "root_subject": rfc4514_windows(root_cert.subject),
        "root_thumbprint": thumbprint(root_cert),
        "root_not_after": root_cert.not_valid_after_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "files": {k: v.name for k, v in files.items() if k != "json"},
        "created_by": "make_publisher.py",
        "created_utc": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    files["json"].write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")

    print(f"\nPublisher '{a.publisher}' created in {out}")
    print(f"  signing certificate  {info['signing_thumbprint']}  valid until {info['signing_not_after'][:10]}")
    print(f"  root certificate     {info['root_thumbprint']}  valid until {info['root_not_after'][:10]}")
    print(f"\nKeep {files['root_backup'].name} and the password OFFLINE. Never ship the .pfx files; ship only the .cer files.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
