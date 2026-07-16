import { create } from "@bufbuild/protobuf";
import { durationFromMs, timestampDate } from "@bufbuild/protobuf/wkt";
import type { Client } from "@connectrpc/connect";

import {
  IssueSandboxSSHCertRequestSchema,
  type SSHGatewayClientService,
} from "./internal/proto/tenki/sandbox/v1/ssh_gateway_client_pb.js";

// SSH features allowed for the issued certificate.
export interface SSHCertPermissions {
  allowPty: boolean;
  allowAgentForwarding: boolean;
  allowPortForwardingLocal: boolean;
  allowPortForwardingRemote: boolean;
  allowX11Forwarding: boolean;
}

// Credentials returned by issueSandboxSSHCert.
export interface SSHCert {
  /**
   * OpenSSH cert in authorized_keys format (begins with
   * "ssh-ed25519-cert-v01@openssh.com"). Write it to disk alongside the
   * private key as `<key>-cert.pub` so ssh auto-loads it, or pass it via
   * `-o CertificateFile=`.
   */
  sshCert: string;
  /** User-CA public key for known_hosts pinning. */
  caPub: string;
  /** Hex-encoded serial, for audit/revocation correlation. */
  certSerial: string;
  /** Absolute expiry; new authentication attempts fail after this time. */
  expiresAt?: Date;
  /** Elapsed-time hint after issuance for minting a cert for a later connection. */
  renewalAfterMs?: number;
  /** Resolved permissions echoed from issuance policy. */
  permissions?: SSHCertPermissions;
}

// Requests a user certificate for the caller-owned OpenSSH public key.
// The service caps ttlMs to policy; omit it to use the default validity.
export async function issueSandboxSSHCert(
  gatewayClient: Client<typeof SSHGatewayClientService>,
  sessionId: string,
  publicKey: string,
  ttlMs?: number,
): Promise<SSHCert> {
  const sid = sessionId.trim();
  if (!sid) throw new Error("session_id required");
  const pub = publicKey.trim();
  if (!pub) throw new Error("public_key required");

  const req = create(IssueSandboxSSHCertRequestSchema, {
    sessionId: sid,
    publicKey: pub,
  });
  if (ttlMs && ttlMs > 0) {
    req.requestedTtl = durationFromMs(ttlMs);
  }

  const resp = await gatewayClient.issueSandboxSSHCert(req);
  return {
    sshCert: resp.sshCert,
    caPub: resp.caPub,
    certSerial: resp.certSerial,
    expiresAt: resp.expiresAt ? timestampDate(resp.expiresAt) : undefined,
    renewalAfterMs: resp.renewalAfter
      ? Number(resp.renewalAfter.seconds) * 1000 + Math.floor(resp.renewalAfter.nanos / 1_000_000)
      : undefined,
    permissions: resp.permissions
      ? {
          allowPty: resp.permissions.allowPty,
          allowAgentForwarding: resp.permissions.allowAgentForwarding,
          allowPortForwardingLocal: resp.permissions.allowPortForwardingLocal,
          allowPortForwardingRemote: resp.permissions.allowPortForwardingRemote,
          allowX11Forwarding: resp.permissions.allowX11Forwarding,
        }
      : undefined,
  };
}
