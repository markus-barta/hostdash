{
  description = "HostDash static service dashboards for fleet hosts";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];

      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;

      mkDashboardPackage =
        pkgs:
        {
          host,
          metaDescription,
        }:
        let
          pname = "hostdash-${host}";
        in
        pkgs.stdenvNoCC.mkDerivation {
          inherit pname;
          src = ./.;
          version = "0.1.0";

          dontConfigure = true;
          dontBuild = true;

          installPhase = ''
            runHook preInstall
            install -d "$out/share/${pname}"
            cp -R public/. "$out/share/${pname}/"
            cp "hosts/${host}/config.js" "$out/share/${pname}/config.js"
            if [ -f "hosts/${host}/manifest.json" ]; then
              cp "hosts/${host}/manifest.json" "$out/share/${pname}/manifest.json"
            fi
            runHook postInstall
          '';

          meta = {
            description = metaDescription;
            platforms = supportedSystems;
          };
        };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          hsb1 = mkDashboardPackage pkgs {
            host = "hsb1";
            metaDescription = "HostDash service dashboard for hsb1";
          };
          hsb0 = mkDashboardPackage pkgs {
            host = "hsb0";
            metaDescription = "HostDash service dashboard for hsb0";
          };
          hsb8 = mkDashboardPackage pkgs {
            host = "hsb8";
            metaDescription = "HostDash service dashboard for hsb8";
          };
          hsb9 = mkDashboardPackage pkgs {
            host = "hsb9";
            metaDescription = "HostDash service dashboard for hsb9";
          };
          csb0 = mkDashboardPackage pkgs {
            host = "csb0";
            metaDescription = "HostDash service dashboard for csb0";
          };
          csb1 = mkDashboardPackage pkgs {
            host = "csb1";
            metaDescription = "HostDash service dashboard for csb1";
          };
        in
        {
          inherit
            csb0
            csb1
            hsb0
            hsb1
            hsb8
            hsb9
            ;
          default = hsb1;
        }
      );
    };
}
