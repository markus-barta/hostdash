window.HOSTDASH_CONFIG = {
  slug: "hsb8",
  storageKey: "hostdash.hsb8",
  presentation: { audience: "family", density: "tiles" },
  contact: { name: "Markus" },
  host: {
    name: "hsb8",
    role: { en: "parents' home", de: "Zuhause" },
    os: "NixOS",
    fqdn: "hsb8.lan",
    ip: "192.168.1.100",
    title: { en: "hsb8 · parents' home", de: "hsb8 · Zuhause" },
    heading: { en: "Services", de: "Dienste" },
  },
  meta: [
    { text: "hosts/hsb8/docker", code: true },
    { text: "hsb8-home", code: true },
    { en: "Europe/Vienna", de: "Europa/Wien" },
  ],
  wings: [
    { id: "network", name: { en: "Network Core", de: "Netzwerk" }, color: "var(--home)", icon: "radio-tower" },
    { id: "home", name: { en: "Home Automation", de: "Hausautomation" }, color: "var(--media)", icon: "house" },
    { id: "ops", name: { en: "Fleet & Ops", de: "Betrieb" }, color: "var(--signals)", icon: "radar" },
    { id: "housekeeping", name: { en: "Housekeeping", de: "Wartung" }, color: "var(--infra)", icon: "refresh-cw" },
  ],
  services: [
    { wing: "network", name: "AdGuard Home", unit: "adguardhome.service", purpose: { en: "Local DNS, DHCP, filtering, and leases", de: "Lokales DNS, Adressvergabe (DHCP) und Werbefilter" }, icon: "logo-adguard", url: "http://hsb8.lan:3000/", sameHost: true, port: ":3000" },

    { wing: "home", name: "Home Assistant", container: "homeassistant", purpose: { en: "Parents' home automation hub", de: "Zentrale der Hausautomation" }, icon: "logo-ha", url: "http://hsb8.lan:8123/", sameHost: true, port: ":8123" },
    { wing: "home", name: "Mosquitto", container: "mosquitto", purpose: { en: "MQTT broker for local automations", de: "Nachrichtenzentrale (MQTT) für die Hausautomation" }, icon: "logo-mqtt", passive: true, foot: { en: ":1883 · broker", de: ":1883 · Broker" } },

    { wing: "ops", name: "pharos-beacon", container: "pharos-beacon", purpose: { en: "Host status to pharosd on csb1", de: "Meldet den Gerätestatus an pharosd auf csb1" }, icon: "radar", passive: true, foot: { en: "beacon · outbound only", de: "Beacon · nur ausgehend" } },

    { wing: "housekeeping", name: { en: "Container updates", de: "Container-Updates" }, unit: "compose-hsb8-update.timer", purpose: { en: "Weekly updates for the compose stack", de: "Wöchentliche Updates für den Compose-Stack" }, icon: "refresh-cw", passive: true, foot: { en: "Sat 05:00 · scheduled", de: "Sa 05:00 · geplant" } },
  ],
};
