{
  description = "jj-graph: a DAG-centred web UI and MCP server for Jujutsu, with the jjr framework";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      # Only what the build and its tests read, so README or asset edits do
      # not rebuild it. The web UI and docs are compiled into the binary.
      src = pkgs: pkgs.lib.fileset.toSource {
        root = ./.;
        fileset = pkgs.lib.fileset.unions [
          ./Cargo.toml
          ./Cargo.lock
          ./crates
          ./public
          ./docs
        ];
      };
      version = (builtins.fromTOML (builtins.readFile ./Cargo.toml)).workspace.package.version;
    in
    {
      packages = forAllSystems (pkgs: rec {
        jj-graph = pkgs.rustPlatform.buildRustPackage {
          pname = "jj-graph";
          inherit version;
          src = src pkgs;
          cargoLock.lockFile = ./Cargo.lock;
          cargoBuildFlags = [ "-p" "jj-graph" ];
          # Every test, the eval scenarios included, runs against throwaway
          # repositories with jj (and git for the convergence scenario).
          cargoTestFlags = [ "--workspace" ];
          nativeBuildInputs = [ pkgs.makeWrapper ];
          nativeCheckInputs = [ pkgs.jujutsu pkgs.git ];
          # Optimized jj-lib and jj-cli take over 4 GiB per rustc process:
          # cap the jobs so a build cannot run the machine out of memory.
          preBuild = ''
            if [ "$NIX_BUILD_CORES" -gt 2 ]; then NIX_BUILD_CORES=2; fi
          '';
          preCheck = ''
            export HOME=$TMPDIR
          '';
          # jj-graph writes through the jj its libraries come from.
          postInstall = ''
            wrapProgram $out/bin/jj-graph --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.jujutsu ]}
          '';
          meta = {
            description = "Touch-first web UI and MCP server for Jujutsu built around the revision graph";
            license = pkgs.lib.licenses.mit;
            mainProgram = "jj-graph";
          };
        };
        default = jj-graph;

        # The OpenCode plugin directory, with jj-graph's store path in place of
        # `jj-graph` on PATH. Link it into ~/.config/opencode/plugins/jj-graph,
        # or list its path under `plugins` in opencode.json.
        opencode-plugin =
          pkgs.runCommand "jj-graph-opencode-plugin-${version}"
            {
              # The plugin's layout.js is a symlink to public/layout.js, which
              # a fileset cannot hold: copy the file in its place.
              src = pkgs.lib.fileset.toSource {
                root = ./.;
                fileset = pkgs.lib.fileset.unions [
                  ./public/layout.js
                  (pkgs.lib.fileset.fileFilter (f: f.hasExt "ts" || f.hasExt "tsx") ./.opencode/plugins/jj-graph)
                ];
              };
              nativeBuildInputs = [ pkgs.bun ];
              meta.description = "OpenCode plugin for jj-graph: its tools, and the jj graph in the TUI";
            }
            ''
              cp -r $src/.opencode/plugins/jj-graph plugin
              chmod -R u+w plugin
              cp $src/public/layout.js plugin/layout.js
              (cd plugin && HOME=$TMPDIR bun test model.test.ts)
              mkdir -p $out
              cp plugin/index.ts plugin/engine.ts plugin/model.ts plugin/rpc.ts plugin/tui.tsx plugin/layout.js $out/
              substituteInPlace $out/index.ts \
                --replace-fail 'const DEFAULT_COMMAND = "jj-graph"' \
                               'const DEFAULT_COMMAND = "${pkgs.lib.getExe jj-graph}"'
            '';
      });

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = nixpkgs.lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.jj-graph;
          meta.description = "Serve jj-graph for a repository (default: the current one)";
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.cargo
            pkgs.rustc
            pkgs.clippy
            pkgs.rustfmt
            pkgs.rust-analyzer
            pkgs.jujutsu
            pkgs.git
            pkgs.nodejs_24
          ];
          # Two parallel rustc jobs keep a debug build of jj-lib well inside 16 GiB.
          CARGO_BUILD_JOBS = "2";
        };
      });

      # `nix flake check` builds jj-graph with its full test suite and the
      # OpenCode plugin, and runs the web UI's layout tests.
      checks = forAllSystems (pkgs: {
        jj-graph = self.packages.${pkgs.stdenv.hostPlatform.system}.jj-graph;
        opencode-plugin = self.packages.${pkgs.stdenv.hostPlatform.system}.opencode-plugin;
        web = pkgs.runCommand "jj-graph-web-tests" {
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [ ./package.json ./public ./test ];
          };
          nativeBuildInputs = [ pkgs.nodejs_24 ];
        } ''
          cp -r $src source && chmod -R u+w source && cd source
          node --test
          touch $out
        '';
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
