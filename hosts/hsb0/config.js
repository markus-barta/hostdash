window.HOSTDASH_CONFIG = {
  slug: "hsb0",
  storageKey: "hostdash.hsb0",
  host: {
    name: "hsb0",
    role: "network core",
    os: "NixOS",
    fqdn: "hsb0.lan",
    ip: "192.168.1.99",
    title: "hsb0 · network core",
    heading: "Services",
  },
  meta: [
    { text: "hosts/hsb0/docker", code: true },
    { text: "hsb0-home", code: true },
    "Europe/Vienna",
  ],
  wings: [
    { id: "network", name: "DNS & Cache", color: "var(--home)", icon: "radio-tower" },
    { id: "agents", name: "Agents & Fleet", color: "var(--media)", icon: "radar" },
    { id: "telemetry", name: "Telemetry", color: "var(--signals)", icon: "satellite-dish" },
    { id: "housekeeping", name: "Housekeeping", color: "var(--infra)", icon: "refresh-cw" },
  ],
  services: [
    { wing: "network", name: "AdGuard Home", purpose: "LAN DNS, DHCP, filtering, and rewrites", icon: "logo-adguard", url: "http://hsb0.lan:3000/", sameHost: true, port: ":3000" },
    { wing: "network", name: "NCPS", purpose: "Nix binary cache proxy for the LAN fleet", icon: "hard-drive-download", url: "http://hsb0.lan:8501/", sameHost: true, port: ":8501" },

    { wing: "agents", name: "OpenClaw Gateway", purpose: "Merlin and Nimue multi-agent control UI", icon: "logo-openclaw", url: "https://hsb0.lan:18789/", sameHost: true, scheme: "https:", port: ":18789", certIssue: true, note: "gateway is HTTPS-only and uses a self-signed certificate" },
    { wing: "agents", name: "FleetCom Bosun", purpose: "Heartbeats and lifecycle events to fleet.barta.cm", icon: "satellite-dish", passive: true, foot: "agent · outbound only" },
    { wing: "agents", name: "FleetCom bridge", purpose: "OpenClaw log/state bridge for FleetCom", icon: "radar", passive: true, foot: "127.0.0.1:9180 · internal" },

    { wing: "telemetry", name: "Speedtest Tracker", purpose: "Starlink WAN speed history and scheduled checks", icon: "logo-speedtest", url: "http://hsb0.lan:8765/", sameHost: true, port: ":8765" },
    { wing: "telemetry", name: "pharos-beacon", purpose: "Host status to pharosd on csb1", icon: "radar", passive: true, foot: "beacon · outbound only" },
    { wing: "telemetry", name: "UPS MQTT", purpose: "APC UPS status published into MQTT", icon: "logo-mqtt", passive: true, foot: "1 min timer · no UI" },

    { wing: "housekeeping", name: "restic", purpose: "Nightly backup to Hetzner Storage Box", icon: "hard-drive-download", passive: true, foot: "02:00 daily · backup" },
    { wing: "housekeeping", name: "SMTP relay", purpose: "Outbound container mail through Hover", icon: "mail", passive: true, foot: ":25 internal · relay" },
    { wing: "housekeeping", name: "Watchtower", purpose: "Weekly updates for opted-in containers", icon: "refresh-cw", passive: true, foot: "Sat 05:00 · scheduled" },
  ],
};
