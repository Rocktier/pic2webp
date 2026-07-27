// Pic2WebP — main entry point
// Routes to CLI mode or Tauri GUI based on args

fn main() {
    let args: Vec<String> = std::env::args().collect();
    
    // CLI mode: pic2webp --cli [options]
    if args.len() > 1 && args[1] == "--cli" {
        pic2webp_lib::run_cli(&args[2..]);
    } else {
        pic2webp_lib::run();
    }
}
