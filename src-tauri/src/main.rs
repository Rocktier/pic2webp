// Pic2WebP — main entry point
// Routes to CLI mode or Tauri GUI based on args

// On Windows, don't allocate a console window for the GUI app.
// CLI mode still inherits stdout/stderr when run from a real terminal.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    
    // CLI mode: pic2webp --cli [options]
    if args.len() > 1 && args[1] == "--cli" {
        pic2webp_lib::run_cli(&args[2..]);
    } else {
        pic2webp_lib::run();
    }
}
