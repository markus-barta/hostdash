window.HOSTDASH_CONFIG = {
  slug: "hsb9",
  storageKey: "hostdash.hsb9",
  host: {
    name: "hsb9",
    role: "parents-in-law",
    os: "NixOS",
    fqdn: "hsb9.lan",
    ip: "192.168.1.200",
    title: "hsb9 · parents-in-law",
    heading: "Services",
  },
  meta: [
    { text: "hosts/hsb9/docker", code: true },
    { text: "hsb9-home", code: true },
    "Europe/Vienna",
  ],
  wings: [
    { id: "home", name: "Home Automation", color: "var(--home)", icon: "house" },
    { id: "ops", name: "Fleet & Ops", color: "var(--signals)", icon: "radar" },
    { id: "housekeeping", name: "Housekeeping", color: "var(--infra)", icon: "refresh-cw" },
  ],
  services: [
    { wing: "home", name: "Home Assistant", purpose: "Parents-in-law home automation hub", icon: "logo-ha", url: "http://hsb9.lan:8123/", sameHost: true, port: ":8123" },
    { wing: "home", name: "Mosquitto", purpose: "MQTT broker for local automations", icon: "logo-mqtt", passive: true, foot: ":1883 · broker" },

    { wing: "ops", name: "pharos-beacon", purpose: "Host status to pharosd on csb1", icon: "radar", passive: true, foot: "beacon · outbound only" },

    { wing: "housekeeping", name: "Watchtower Weekly", purpose: "Weekly updates for label-enabled containers", icon: "refresh-cw", passive: true, foot: "Sat 05:00 · scheduled" },
  ],
};
