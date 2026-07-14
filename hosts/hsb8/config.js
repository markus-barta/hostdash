window.HOSTDASH_CONFIG = {
  slug: "hsb8",
  storageKey: "hostdash.hsb8",
  host: {
    name: "hsb8",
    role: "parents' home",
    os: "NixOS",
    fqdn: "hsb8.lan",
    ip: "192.168.1.100",
    title: "hsb8 · parents' home",
    heading: "Services",
  },
  meta: [
    { text: "hosts/hsb8/docker", code: true },
    { text: "hsb8-home", code: true },
    "Europe/Vienna",
  ],
  wings: [
    { id: "network", name: "Network Core", color: "var(--home)", icon: "radio-tower" },
    { id: "home", name: "Home Automation", color: "var(--media)", icon: "house" },
    { id: "ops", name: "Fleet & Ops", color: "var(--signals)", icon: "radar" },
    { id: "housekeeping", name: "Housekeeping", color: "var(--infra)", icon: "refresh-cw" },
  ],
  services: [
    { wing: "network", name: "AdGuard Home", purpose: "Local DNS, DHCP, filtering, and leases", icon: "logo-adguard", url: "http://hsb8.lan:3000/", sameHost: true, port: ":3000" },

    { wing: "home", name: "Home Assistant", purpose: "Parents' home automation hub", icon: "logo-ha", url: "http://hsb8.lan:8123/", sameHost: true, port: ":8123" },
    { wing: "home", name: "Mosquitto", purpose: "MQTT broker for local automations", icon: "logo-mqtt", passive: true, foot: ":1883 · broker" },

    { wing: "ops", name: "pharos-beacon", purpose: "Host status to pharosd on csb1", icon: "radar", passive: true, foot: "beacon · outbound only" },

    { wing: "housekeeping", name: "Watchtower", purpose: "Weekly updates for scoped containers", icon: "refresh-cw", passive: true, foot: "Sat 05:00 · scheduled" },
  ],
};
