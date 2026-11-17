use std::io::{self, BufRead};
fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        println!(
            "{}",
            playground_compiler::compile(
                value["filename"].as_str().unwrap(),
                value["source"].as_str().unwrap(),
                value["runtime"].as_str().unwrap()
            )
        );
    }
}
