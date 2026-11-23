{ pkgs, ... }:

{
  # jj-graph is Rust on jj-lib; it writes through the jj CLI of the same
  # release (0.47.1), and git backs the convergence scenario's bare remote.
  # Node only runs the web UI's layout tests.
  languages.rust.enable = true;
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
  };

  packages = [ pkgs.jujutsu pkgs.git ];

  # Optimized jj-lib and jj-cli take over 4 GiB per rustc process, so keep
  # parallel jobs low enough for a 16 GiB machine.
  env.CARGO_BUILD_JOBS = "2";

  scripts = {
    serve.exec = ''cargo run --quiet -p jj-graph -- "$@"'';
    serve.description = "Serve jj-graph for a repository (default: the current one)";
    mcp.exec = ''cargo run --quiet -p jj-graph -- mcp "$@"'';
    mcp.description = "Serve jj-graph to an agent over MCP on stdio";
    jjr-eval.exec = "cargo test -p jj-graph --test evals";
    jjr-eval.description = "Run the jjr eval scenarios against throwaway jj repositories";
  };

  # `devenv up` serves jj-graph for this repository on http://127.0.0.1:7777.
  processes.jj-graph.exec = "cargo run --quiet -p jj-graph -- --port 7777";

  enterShell = ''
    echo "jj-graph: $(rustc --version), $(jj --version)"
    echo "  serve [REPO] [--verify-command CMD]   mcp [REPO]   jjr-eval   devenv test   devenv up"
  '';

  # `devenv test` runs every Rust test (the eval scenarios included), then
  # the web UI's layout tests.
  enterTest = ''
    cargo test --workspace
    node --test
  '';
}
