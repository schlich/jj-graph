//! The jj command model (jj 0.47 CLI).
//!
//! Guardrails must check the revisions a command really rewrites, not merely
//! the ones it names. `jj new X` only reads X, `jj new -B X` rewrites X,
//! `jj new -A X` rewrites X's children, and `jj squash` with no flags
//! rewrites both `@` and `@-`. This module classifies every revision argument
//! of a jj command line by what the command does to it.

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

/// What a command does to the revisions an argument names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ArgumentRole {
    /// The revisions are rewritten (jj's immutability check applies).
    Rewrite,
    /// The children of the revisions are rebased, so they are rewritten.
    Children,
    /// The revisions become parents of new or moved work (read only).
    Parent,
    /// The revisions are only read.
    Source,
    /// A bookmark will point at the revision.
    Bookmark,
    /// An option value that is not a revision (message, tool, ...).
    Value,
    /// Positional paths.
    Fileset,
    /// Positional names (bookmarks, tags).
    Name,
    /// Positional arguments are not revisions.
    None,
}

/// One option of a command: which slot it fills and what that slot's
/// revisions are to the command.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct OptionSpec {
    pub slot: &'static str,
    pub role: ArgumentRole,
}

/// How a jj command treats its arguments. `defaults` gives the revision a
/// slot falls back to when the command line leaves it out, and `recovery`
/// marks divergence-recovery commands.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JjCommandSpec {
    pub positional: ArgumentRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub positional_slot: Option<&'static str>,
    /// Options in declaration order; the first one naming a slot gives its role.
    pub options: Vec<(&'static str, OptionSpec)>,
    pub defaults: Vec<(&'static str, &'static str)>,
    pub recovery: bool,
    pub creates: bool,
}

impl JjCommandSpec {
    /// The spec of option `name`, as jj parses it.
    pub fn option(&self, name: &str) -> Option<OptionSpec> {
        self.options
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, o)| *o)
    }
}

/// Global options that take a value.
const GLOBAL_VALUE_OPTIONS: &[&str] = &[
    "-R",
    "--repository",
    "--at-op",
    "--at-operation",
    "--color",
    "--config",
    "--config-file",
];
/// Commands whose first positional argument names a subcommand.
const GROUPS: &[&str] = &[
    "bookmark",
    "b",
    "tag",
    "op",
    "operation",
    "git",
    "workspace",
    "config",
    "util",
    "file",
    "sparse",
    "gerrit",
];

fn group_alias(word: &str) -> &str {
    match word {
        "b" => "bookmark",
        "operation" => "op",
        other => other,
    }
}

const fn opt(slot: &'static str, role: ArgumentRole) -> OptionSpec {
    OptionSpec { slot, role }
}

fn insert() -> Vec<(&'static str, OptionSpec)> {
    use ArgumentRole::{Children, Parent, Rewrite};
    vec![
        ("-o", opt("onto", Parent)),
        ("--onto", opt("onto", Parent)),
        ("-d", opt("onto", Parent)),
        ("--destination", opt("onto", Parent)),
        ("-A", opt("after", Children)),
        ("--insert-after", opt("after", Children)),
        ("--after", opt("after", Children)),
        ("-B", opt("before", Rewrite)),
        ("--insert-before", opt("before", Rewrite)),
        ("--before", opt("before", Rewrite)),
    ]
}

fn revision(role: ArgumentRole) -> Vec<(&'static str, OptionSpec)> {
    vec![
        ("-r", opt("revision", role)),
        ("--revision", opt("revision", role)),
        ("--revisions", opt("revision", role)),
    ]
}

fn message() -> Vec<(&'static str, OptionSpec)> {
    vec![
        ("-m", opt("message", ArgumentRole::Value)),
        ("--message", opt("message", ArgumentRole::Value)),
    ]
}

fn tool() -> Vec<(&'static str, OptionSpec)> {
    vec![("--tool", opt("tool", ArgumentRole::Value))]
}

fn spec(
    positional: ArgumentRole,
    positional_slot: Option<&'static str>,
    groups: Vec<Vec<(&'static str, OptionSpec)>>,
    defaults: &[(&'static str, &'static str)],
) -> JjCommandSpec {
    JjCommandSpec {
        positional,
        positional_slot,
        options: groups.into_iter().flatten().collect(),
        defaults: defaults.to_vec(),
        recovery: false,
        creates: false,
    }
}

fn recovery(mut s: JjCommandSpec) -> JjCommandSpec {
    s.recovery = true;
    s
}

fn creates(mut s: JjCommandSpec) -> JjCommandSpec {
    s.creates = true;
    s
}

/// Per-command specifications, in the order jjr documents them.
pub static JJ_COMMAND_SPECS: LazyLock<Vec<(&'static str, JjCommandSpec)>> = LazyLock::new(|| {
    use ArgumentRole::{Bookmark, Fileset, Name, Parent, Rewrite, Source, Value};
    let none = ArgumentRole::None;
    let o = |pairs: &[(&'static str, OptionSpec)]| pairs.to_vec();
    vec![
        (
            "abandon",
            recovery(spec(
                Rewrite,
                Some("revision"),
                vec![revision(Rewrite)],
                &[("revision", "@")],
            )),
        ),
        (
            "absorb",
            spec(
                Fileset,
                None,
                vec![
                    o(&[
                        ("-f", opt("from", Rewrite)),
                        ("--from", opt("from", Rewrite)),
                        ("-t", opt("into", Rewrite)),
                        ("--into", opt("into", Rewrite)),
                        ("--to", opt("into", Rewrite)),
                    ]),
                    tool(),
                ],
                &[("from", "@")],
            ),
        ),
        (
            "converge",
            recovery(spec(none, None, vec![revision(Rewrite)], &[])),
        ),
        (
            "describe",
            spec(
                Rewrite,
                Some("revision"),
                vec![revision(Rewrite), message()],
                &[("revision", "@")],
            ),
        ),
        (
            "duplicate",
            creates(spec(
                Source,
                Some("revision"),
                vec![insert()],
                &[("revision", "@")],
            )),
        ),
        (
            "edit",
            spec(Rewrite, Some("revision"), vec![revision(Rewrite)], &[]),
        ),
        (
            "fix",
            spec(
                Fileset,
                None,
                vec![o(&[
                    ("-s", opt("source", Rewrite)),
                    ("--source", opt("source", Rewrite)),
                ])],
                &[],
            ),
        ),
        (
            "metaedit",
            spec(
                Rewrite,
                Some("revision"),
                vec![
                    revision(Rewrite),
                    message(),
                    o(&[
                        ("--author", opt("author", Value)),
                        ("--author-timestamp", opt("author", Value)),
                    ]),
                ],
                &[("revision", "@")],
            ),
        ),
        (
            "new",
            creates(spec(
                Parent,
                Some("parents"),
                vec![revision(Parent), message(), insert()],
                &[],
            )),
        ),
        ("next", spec(Value, None, vec![], &[])),
        ("parallelize", spec(Rewrite, Some("revision"), vec![], &[])),
        ("prev", spec(Value, None, vec![], &[])),
        (
            "rebase",
            spec(
                none,
                None,
                vec![
                    o(&[
                        ("-b", opt("branch", Rewrite)),
                        ("--branch", opt("branch", Rewrite)),
                        ("-s", opt("source", Rewrite)),
                        ("--source", opt("source", Rewrite)),
                    ]),
                    revision(Rewrite),
                    insert(),
                ],
                &[],
            ),
        ),
        (
            "restore",
            spec(
                Fileset,
                None,
                vec![
                    o(&[
                        ("-f", opt("from", Source)),
                        ("--from", opt("from", Source)),
                        ("-t", opt("into", Rewrite)),
                        ("--into", opt("into", Rewrite)),
                        ("--to", opt("into", Rewrite)),
                        ("-c", opt("changes", Rewrite)),
                        ("--changes-in", opt("changes", Rewrite)),
                    ]),
                    tool(),
                ],
                &[],
            ),
        ),
        (
            "revert",
            creates(spec(none, None, vec![revision(Source), insert()], &[])),
        ),
        (
            "simplify-parents",
            spec(
                none,
                None,
                vec![
                    o(&[
                        ("-s", opt("source", Rewrite)),
                        ("--source", opt("source", Rewrite)),
                    ]),
                    revision(Rewrite),
                ],
                &[],
            ),
        ),
        (
            "split",
            creates(spec(
                Fileset,
                None,
                vec![revision(Rewrite), message(), tool(), insert()],
                &[("revision", "@")],
            )),
        ),
        (
            "squash",
            spec(
                Fileset,
                None,
                vec![
                    revision(Rewrite),
                    o(&[
                        ("-f", opt("from", Rewrite)),
                        ("--from", opt("from", Rewrite)),
                        ("-t", opt("into", Rewrite)),
                        ("--into", opt("into", Rewrite)),
                        ("--to", opt("into", Rewrite)),
                    ]),
                    message(),
                    tool(),
                    insert(),
                ],
                &[],
            ),
        ),
        (
            "bookmark create",
            spec(Name, None, vec![revision(Bookmark)], &[("revision", "@")]),
        ),
        (
            "bookmark set",
            spec(Name, None, vec![revision(Bookmark)], &[("revision", "@")]),
        ),
        (
            "bookmark move",
            spec(
                Name,
                None,
                vec![o(&[
                    ("-f", opt("from", Source)),
                    ("--from", opt("from", Source)),
                    ("-t", opt("to", Bookmark)),
                    ("--to", opt("to", Bookmark)),
                ])],
                &[("to", "@")],
            ),
        ),
        ("bookmark delete", spec(Name, None, vec![], &[])),
        ("bookmark forget", spec(Name, None, vec![], &[])),
        ("bookmark rename", spec(Name, None, vec![], &[])),
        ("bookmark track", spec(Name, None, vec![], &[])),
        ("bookmark untrack", spec(Name, None, vec![], &[])),
        (
            "tag set",
            spec(Name, None, vec![revision(Source)], &[("revision", "@")]),
        ),
        ("tag delete", spec(Name, None, vec![], &[])),
        ("op restore", recovery(spec(Value, None, vec![], &[]))),
        ("op revert", recovery(spec(Value, None, vec![], &[]))),
    ]
});

/// The spec of a command (`"rebase"`, `"bookmark set"`, ...).
pub fn command_spec(command: &str) -> Option<&'static JjCommandSpec> {
    JJ_COMMAND_SPECS
        .iter()
        .find(|(name, _)| *name == command)
        .map(|(_, s)| s)
}

/// One option value from a command line.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ParsedOption {
    pub name: String,
    pub slot: &'static str,
    pub role: ArgumentRole,
    pub value: String,
}

/// A jj argv split into command, options and positional arguments.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedJjArgs {
    pub command: String,
    pub spec: Option<&'static JjCommandSpec>,
    pub options: Vec<ParsedOption>,
    pub positional: Vec<String>,
    pub flags: Vec<String>,
    pub ignore_immutable: bool,
}

fn split_at_char(s: &str, n: usize) -> (&str, &str) {
    match s.char_indices().nth(n) {
        Some((i, _)) => s.split_at(i),
        None => (s, ""),
    }
}

/// Split a jj argv (without the leading `jj`) into command, options and
/// positional arguments using the command's spec.
pub fn parse_jj_args<S: AsRef<str>>(args: &[S]) -> ParsedJjArgs {
    let args: Vec<&str> = args.iter().map(AsRef::as_ref).collect();
    let mut out = ParsedJjArgs::default();
    if args.is_empty() {
        return out;
    }
    let mut words: Vec<String> = Vec::new();
    let mut rest: Vec<&str> = Vec::new();
    let mut i = 0;
    // Leading global options may precede the command.
    while i < args.len() {
        let a = args[i];
        if a == "--ignore-immutable" {
            out.ignore_immutable = true;
            i += 1;
            continue;
        }
        if GLOBAL_VALUE_OPTIONS.contains(&a) {
            i += 2;
            continue;
        }
        if a.starts_with('-') {
            i += 1;
            continue;
        }
        break;
    }
    if i < args.len() {
        words.push(group_alias(args[i]).to_owned());
        i += 1;
    }
    if words.first().is_some_and(|w| GROUPS.contains(&w.as_str())) {
        while i < args.len() {
            let a = args[i];
            if a.starts_with('-') {
                rest.push(a);
                i += 1;
                continue;
            }
            words.push(a.to_owned());
            i += 1;
            break;
        }
    }
    rest.extend(args.iter().skip(i));
    out.command = words.join(" ");
    let spec = command_spec(&out.command);
    out.spec = spec;

    let lookup = |name: &str| spec.and_then(|s| s.option(name));
    let mut positional_only = false;
    let mut k = 0;
    while k < rest.len() {
        let a = rest[k];
        k += 1;
        if positional_only {
            out.positional.push(a.to_owned());
            continue;
        }
        if a == "--" {
            positional_only = true;
            continue;
        }
        if a == "--ignore-immutable" {
            out.ignore_immutable = true;
            continue;
        }
        if GLOBAL_VALUE_OPTIONS.contains(&a) {
            k += 1;
            continue;
        }
        if a.starts_with("--") {
            let (name, inline) = match a.find('=') {
                Some(eq) => (&a[..eq], Some(&a[eq + 1..])),
                None => (a, None),
            };
            if GLOBAL_VALUE_OPTIONS.contains(&name) {
                continue;
            }
            let Some(o) = lookup(name) else {
                out.flags.push(name.to_owned());
                continue;
            };
            let value = match inline {
                Some(v) => Some(v),
                None => {
                    let v = rest.get(k).copied();
                    k += 1;
                    v
                }
            };
            if let Some(value) = value {
                out.options.push(ParsedOption {
                    name: name.to_owned(),
                    slot: o.slot,
                    role: o.role,
                    value: value.to_owned(),
                });
            }
            continue;
        }
        if a.starts_with('-') && a.chars().count() > 1 {
            let (name, attached) = split_at_char(a, 2);
            let Some(o) = lookup(name) else {
                out.flags.push(a.to_owned());
                continue;
            };
            let attached = attached.strip_prefix('=').unwrap_or(attached);
            let value = if attached.is_empty() {
                let v = rest.get(k).copied();
                k += 1;
                v
            } else {
                Some(attached)
            };
            if let Some(value) = value {
                out.options.push(ParsedOption {
                    name: name.to_owned(),
                    slot: o.slot,
                    role: o.role,
                    value: value.to_owned(),
                });
            }
            continue;
        }
        out.positional.push(a.to_owned());
    }
    out
}

/// A bookmark a command points at a revision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BookmarkTarget {
    pub names: Vec<String>,
    pub target: String,
}

/// What a jj command does to the revisions it names.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationDescription {
    pub command: String,
    pub known: bool,
    /// Revsets whose commits the command rewrites (children of `-A` targets as `X+`).
    pub rewrites: Vec<String>,
    pub parents: Vec<String>,
    pub sources: Vec<String>,
    pub bookmarks: Vec<BookmarkTarget>,
    pub revision_args: Vec<String>,
    pub filesets: Vec<String>,
    pub ignore_immutable: bool,
    pub recovery: bool,
    pub creates: bool,
}

/// Slots in the order a command line fills them; a slot keeps the role it
/// was first given.
#[derive(Default)]
struct Slots(Vec<(String, ArgumentRole, Vec<String>)>);

impl Slots {
    fn put(&mut self, slot: &str, role: ArgumentRole, value: impl Into<String>) {
        match self.0.iter_mut().find(|(s, _, _)| s == slot) {
            Some((_, _, values)) => values.push(value.into()),
            None => self.0.push((slot.to_owned(), role, vec![value.into()])),
        }
    }

    fn get(&self, slot: &str) -> Option<&Vec<String>> {
        self.0.iter().find(|(s, _, _)| s == slot).map(|(_, _, v)| v)
    }

    fn has(&self, slot: &str) -> bool {
        self.get(slot).is_some()
    }

    fn remove(&mut self, slot: &str) -> Option<Vec<String>> {
        let i = self.0.iter().position(|(s, _, _)| s == slot)?;
        Some(self.0.remove(i).2)
    }
}

fn dedup(values: &mut Vec<String>) {
    let mut seen = std::collections::HashSet::new();
    values.retain(|v| seen.insert(v.clone()));
}

/// Describe what a jj command (argv without the leading `jj`) does to the
/// revisions it names.
pub fn describe_mutation<S: AsRef<str>>(args: &[S]) -> MutationDescription {
    let p = parse_jj_args(args);
    let mut result = MutationDescription {
        command: p.command.clone(),
        known: p.spec.is_some(),
        ignore_immutable: p.ignore_immutable,
        recovery: p.spec.is_some_and(|s| s.recovery),
        creates: p.spec.is_some_and(|s| s.creates),
        ..Default::default()
    };
    let Some(spec) = p.spec else { return result };

    let mut slots = Slots::default();
    for o in &p.options {
        if o.role == ArgumentRole::Value {
            continue;
        }
        slots.put(o.slot, o.role, o.value.clone());
        result.revision_args.push(o.value.clone());
    }
    for a in &p.positional {
        match spec.positional {
            ArgumentRole::Fileset => result.filesets.push(a.clone()),
            ArgumentRole::Rewrite | ArgumentRole::Parent | ArgumentRole::Source => {
                slots.put(
                    spec.positional_slot.unwrap_or("positional"),
                    spec.positional,
                    a.clone(),
                );
                result.revision_args.push(a.clone());
            }
            _ => {}
        }
    }
    for (slot, rev) in &spec.defaults {
        if !slots.has(slot) {
            let role = spec
                .options
                .iter()
                .find(|(_, o)| o.slot == *slot)
                .map_or(spec.positional, |(_, o)| o.role);
            slots.put(slot, role, *rev);
        }
    }

    if p.command == "squash" {
        squash_slots(&mut slots);
    }
    if p.command == "restore" && !slots.has("into") && !slots.has("changes") {
        slots.put("into", ArgumentRole::Rewrite, "@");
    }
    if p.command == "new"
        && !slots.has("parents")
        && !slots.has("revision")
        && !slots.has("after")
        && !slots.has("before")
    {
        slots.put("parents", ArgumentRole::Parent, "@");
    }
    if p.command == "rebase"
        && !slots.has("branch")
        && !slots.has("source")
        && !slots.has("revision")
    {
        slots.put("branch", ArgumentRole::Rewrite, "@");
    }
    if p.command == "metaedit" && p.flags.iter().any(|f| f == "--update-change-id") {
        result.recovery = true;
    }

    // `bookmark move --from X --to Y` names no bookmark but still points some at Y.
    let bookmark_names: Vec<String> = if p.command.starts_with("bookmark ") {
        if !p.positional.is_empty() {
            p.positional.clone()
        } else if let Some(from) = slots.get("from") {
            from.iter().map(|v| format!("(bookmarks on {v})")).collect()
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };
    for (_, role, values) in &slots.0 {
        for v in values {
            match role {
                ArgumentRole::Rewrite => result.rewrites.push(v.clone()),
                ArgumentRole::Children => result.rewrites.push(children_of(v)),
                ArgumentRole::Parent => result.parents.push(v.clone()),
                ArgumentRole::Source => result.sources.push(v.clone()),
                ArgumentRole::Bookmark if !bookmark_names.is_empty() => {
                    result.bookmarks.push(BookmarkTarget {
                        names: bookmark_names.clone(),
                        target: v.clone(),
                    });
                }
                _ => {}
            }
        }
    }
    dedup(&mut result.rewrites);
    dedup(&mut result.parents);
    dedup(&mut result.sources);
    result
}

/// `jj squash` moves changes from sources into a destination; both are rewritten.
fn squash_slots(slots: &mut Slots) {
    let inserting = slots.has("onto") || slots.has("after") || slots.has("before");
    if let Some(revisions) = slots.remove("revision") {
        // `-r X` squashes X into its parent.
        for r in revisions {
            slots.put("from", ArgumentRole::Rewrite, r.clone());
            if !inserting {
                slots.put("into", ArgumentRole::Rewrite, parents_of(&r));
            }
        }
        return;
    }
    if !slots.has("from") {
        slots.put("from", ArgumentRole::Rewrite, "@");
    }
    if !slots.has("into") && !inserting {
        // "If either is left out, it defaults to the working-copy commit";
        // with neither, jj squashes @ into @-.
        let explicit_from = slots
            .get("from")
            .is_some_and(|v| v.iter().any(|v| v != "@"));
        slots.put(
            "into",
            ArgumentRole::Rewrite,
            if explicit_from { "@" } else { "@-" },
        );
    }
}

static SIMPLE_SYMBOL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_@./-]+$").unwrap());

/// The children of a revset, written so jj and the in-memory resolver both parse it.
pub fn children_of(revset: &str) -> String {
    if SIMPLE_SYMBOL.is_match(revset) && !revset.ends_with('-') {
        format!("{revset}+")
    } else {
        format!("({revset})+")
    }
}

/// The parents of a revset.
pub fn parents_of(revset: &str) -> String {
    if SIMPLE_SYMBOL.is_match(revset) && !revset.ends_with('+') {
        format!("{revset}-")
    } else {
        format!("({revset})-")
    }
}

/// The revisions a jj argv rewrites. Destination-only revisions (`-o`,
/// `jj new X`) are left out; insert-before targets and squash destinations
/// are included because jj rewrites them.
pub fn extract_mutated_targets<S: AsRef<str>>(args: &[S]) -> Vec<String> {
    if args.is_empty() {
        return Vec::new();
    }
    describe_mutation(args).rewrites
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_reads_its_parents_but_insert_before_rewrites() {
        let m = describe_mutation(&["new", "x"]);
        assert!(m.rewrites.is_empty());
        assert_eq!(m.parents, ["x"]);
        assert!(m.creates);
        assert_eq!(describe_mutation(&["new", "-B", "x"]).rewrites, ["x"]);
        assert_eq!(describe_mutation(&["new", "-A", "x"]).rewrites, ["x+"]);
        assert_eq!(describe_mutation(&["new"]).parents, ["@"]);
    }

    #[test]
    fn squash_defaults() {
        assert_eq!(describe_mutation(&["squash"]).rewrites, ["@", "@-"]);
        assert_eq!(
            describe_mutation(&["squash", "--from", "x"]).rewrites,
            ["x", "@"]
        );
        assert_eq!(
            describe_mutation(&["squash", "-r", "x"]).rewrites,
            ["x", "x-"]
        );
        assert_eq!(
            describe_mutation(&["squash", "--from", "a", "--into", "b"]).rewrites,
            ["a", "b"]
        );
    }

    #[test]
    fn rebase_and_bookmarks() {
        let m = describe_mutation(&["rebase", "-s", "x", "-o", "main"]);
        assert_eq!(m.rewrites, ["x"]);
        assert_eq!(m.parents, ["main"]);
        assert_eq!(describe_mutation(&["rebase"]).rewrites, ["@"]);
        let b = describe_mutation(&["bookmark", "set", "feat", "-r", "x"]);
        assert_eq!(b.command, "bookmark set");
        assert_eq!(
            b.bookmarks,
            [BookmarkTarget {
                names: vec!["feat".into()],
                target: "x".into()
            }]
        );
        let mv = describe_mutation(&["b", "move", "--from", "a", "--to", "b"]);
        assert_eq!(mv.bookmarks[0].names, ["(bookmarks on a)"]);
    }

    #[test]
    fn parsing_details() {
        let p = parse_jj_args(&[
            "--ignore-immutable",
            "describe",
            "-mhello",
            "--at-op",
            "abc",
            "x",
        ]);
        assert!(p.ignore_immutable);
        assert_eq!(p.command, "describe");
        assert_eq!(p.options[0].value, "hello");
        assert_eq!(p.positional, ["x"]);
        assert!(describe_mutation(&["abandon"]).recovery);
        assert!(describe_mutation(&["metaedit", "--update-change-id"]).recovery);
        assert_eq!(
            describe_mutation(&["restore", "--from", "a"]).rewrites,
            ["@"]
        );
        assert!(!describe_mutation(&["frobnicate"]).known);
        assert_eq!(children_of("a::b"), "(a::b)+");
        assert_eq!(parents_of("x+"), "(x+)-");
    }
}
