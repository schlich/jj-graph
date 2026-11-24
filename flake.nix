{
  description = "jj-graph: a DAG-centred web UI and MCP server for Jujutsu, with the jjr framework and the jj-normalize change-graph normalizer";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      # Only what the build and its tests read, so README or asset edits do
      # not rebuild it. The web UI and docs are compiled into the binary.
      src = pkgs: pkgs.lib.fileset.toSource {
        root = ./.;
        fileset = pkgs.lib.fileset.difference (pkgs.lib.fileset.unions [
          ./Cargo.toml
          ./Cargo.lock
          ./crates
          ./public
          ./docs
        ]) ./crates/jj-normalize;
      };
      version = (builtins.fromTOML (builtins.readFile ./Cargo.toml)).workspace.package.version;
      # jj-normalize (crates/jj-normalize): its package, whose build runs its
      # lints and tests, and the model checks of its Quint specifications.
      # Linux only: its tests drive jj, Graphviz, and mergiraf.
      normalize = pkgs: import ./crates/jj-normalize { inherit pkgs; inherit (pkgs) lib; };
      onLinux = pkgs: attrs: nixpkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux attrs;
    in
    {
      packages = forAllSystems (pkgs: onLinux pkgs {
        jj-normalize = (normalize pkgs).package;
        # TLC over every graph of NormalizeTiny: about twelve minutes, so it
        # stays out of `nix flake check`.
        jj-normalize-model-exhaustive = (normalize pkgs).exhaustive;
      } // rec {
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

        # The OpenCode plugin directory: the server and TUI parts, and the
        # desktop part built into gui-experimental.cjs, with jj-graph's store
        # path in place of `jj-graph` on PATH. Link it into
        # ~/.config/opencode/plugins/jj-graph, or list its path under
        # `plugins` in opencode.json (the desktop app reads only the global one).
        opencode-plugin = pkgs.buildNpmPackage {
          pname = "jj-graph-opencode-plugin";
          inherit version;
          # Symlinks stay out of the source: the plugin's layout.js link is
          # replaced by public/layout.js, and opencode-gui/plugin is made here.
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./public/layout.js
              (pkgs.lib.fileset.fileFilter (f: f.hasExt "ts" || f.hasExt "tsx" || f.hasExt "css") ./.opencode/plugins/jj-graph)
              ./opencode-gui/package.json
              ./opencode-gui/package-lock.json
              ./opencode-gui/vite.config.ts
              ./opencode-gui/tsconfig.json
              ./opencode-gui/env.d.ts
            ];
          };
          sourceRoot = "source/opencode-gui";
          npmDepsHash = "sha256-FKyykYS2sCd1FG//WVGQNcpBihWNISYQcBsdpWixoIQ=";
          nativeBuildInputs = [ pkgs.bun ];
          # Only sourceRoot is writable after unpacking, and fetchNpmDeps runs
          # the patch hooks too, so set the plugin directory up here.
          preBuild = ''
            chmod -R u+w ..
            cp ../public/layout.js ../.opencode/plugins/jj-graph/layout.js
            ln -s ../.opencode/plugins/jj-graph plugin
            npx tsc -p tsconfig.json
          '';
          postBuild = ''
            (cd ../.opencode/plugins/jj-graph && HOME=$TMPDIR bun test model.test.ts)
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cd ../.opencode/plugins/jj-graph
            cp index.ts engine.ts model.ts rpc.ts tui.tsx layout.js gui-experimental.cjs $out/
            substituteInPlace $out/index.ts \
              --replace-fail 'const DEFAULT_COMMAND = "jj-graph"' \
                             'const DEFAULT_COMMAND = "${pkgs.lib.getExe jj-graph}"'
            runHook postInstall
          '';
          meta.description = "OpenCode plugin for jj-graph: its tools, and the jj graph in the TUI and desktop app";
        };
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
      checks = forAllSystems (pkgs: onLinux pkgs {
        jj-normalize = (normalize pkgs).package;
        jj-normalize-model = (normalize pkgs).model;
      } // {
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
