//! Render-agnostic view models ([`core`]), with TUI ([`tui`]) and GUI
//! ([`gui`]) adapters.
//!
//! Port of `jjr/ui/core.mjs`, `jjr/ui/tui.mjs` and `jjr/ui/gui.mjs`.

pub mod core;
pub mod gui;
pub mod tui;

pub use self::core::*;
pub use self::gui::*;
pub use self::tui::*;
