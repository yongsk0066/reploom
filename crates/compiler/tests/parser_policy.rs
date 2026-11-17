use playground_compiler::compile;
use serde_json::Value;

fn compilation(source: &str) -> Value {
    serde_json::from_str(&compile("/main.tsx", source, "dom")).unwrap()
}

#[test]
fn flat_comparisons_do_not_spend_the_type_recursion_budget() {
    let source = format!("export const values = [{}];", vec!["a < b"; 2048].join(","));
    let result = compilation(&source);
    assert_eq!(result["ok"], true, "{result}");
}

#[test]
fn nested_computed_keys_do_not_repeat_failed_type_parses() {
    let source = format!("{}x{};", "a<{[".repeat(24), "]:1}".repeat(24));
    let result = compilation(&source);
    assert_eq!(result["ok"], true, "{result}");
}

#[test]
fn lexical_and_grammar_contexts_preserve_type_argument_meaning() {
    let cases = [
        "declare function f<T>(): T; const g = f<string>; export {g};",
        "const a=1,b=2,c=3; export const v=[a < b > c,a < b >= c,a < b > +c,a < b > -c];",
        "declare function f<T>(): T; export const v=f<{[(/>/).source]: string}>();",
        "declare function f<T>(): T; type T=string; export const v=f<`x${T}`>();",
        "const a=1,b=2; export const v=<div>{a < b}</div>;",
        "type X<U,T> = T extends infer U extends number ? U : T;",
        "type Y<U,T> = T extends (infer U extends number ? U : T) ? U : T;",
        "function* f(){return [a < b,a < b,a < b,a < b,a < b,a < {[yield x]: 1}];}",
        "async function f(){return [a < b,a < b,a < b,a < b,a < b,a < {[await x]: 1}];}",
        "declare function f<T>(): T; export const v=f<\n{a:string;b:number}\n>();",
        "declare function f<T>(): T; export const v=f<<T>()=>T>();",
    ];
    for source in cases {
        let result = compilation(source);
        assert_eq!(result["ok"], true, "{source}: {result}");
    }
}

#[test]
fn type_depth_budget_survives_speculation_rewinds_and_reports_its_location() {
    let source = format!(
        "// 😀\ndeclare function f<T>(): T;\nexport const v=f<{}T{}>();",
        "A<".repeat(140),
        ">".repeat(140)
    );
    let result = compilation(&source);
    assert_eq!(result["ok"], false);
    let diagnostics = result["error"].as_array().unwrap();
    assert!(
        diagnostics.iter().any(|error| {
            error["text"]
                .as_str()
                .unwrap()
                .contains("nesting budget (32)")
                && error["line"] == 3
                && error["column"].as_u64().is_some_and(|column| column > 16)
        }),
        "{result}"
    );
    assert_eq!(compilation("export const recovered=1;")["ok"], true);
}

#[test]
fn type_depth_is_active_nesting_not_total_type_count() {
    let within = format!("type T={}number{};", "A<".repeat(31), ">".repeat(31));
    assert_eq!(compilation(&within)["ok"], true);
    let over = format!("type T={}number{};", "A<".repeat(32), ">".repeat(32));
    assert_eq!(compilation(&over)["ok"], false);
    let siblings = (0..100)
        .map(|i| format!("type T{i}={};", "number"))
        .collect::<String>();
    assert_eq!(compilation(&siblings)["ok"], true);
}

#[test]
fn recursive_type_forms_share_the_same_budget() {
    for source in [
        format!("type T={}number{};", "(".repeat(140), ")".repeat(140)),
        format!("type T={}number{};", "{x:".repeat(140), "}".repeat(140)),
        format!("type T={}number;", "keyof ".repeat(140)),
        format!("type T={}number;", "!".repeat(140)),
        format!("{}x{};", "a<{[".repeat(140), "]:1}".repeat(140)),
    ] {
        let result = compilation(&source);
        assert_eq!(result["ok"], false, "{source}");
        assert!(
            result["error"].as_array().unwrap().iter().any(|error| {
                error["text"]
                    .as_str()
                    .unwrap()
                    .contains("nesting budget (32)")
            }),
            "{result}"
        );
    }
}

#[test]
fn cover_grammar_refines_ambiguous_lists_without_changing_valid_syntax() {
    for source in [
        "export const f=({x=1},[y,...rest]=[2])=>[x,y,rest];",
        "const a=1,b=2; export const values=[(a),(a,b),((x)=>x)(3)];",
        "export const f=async({x},y=1)=>[await x,y];",
        "const async=(x)=>x; export const value=async({x:1});",
        "export const f=(x: number, y?: string): number=>x;",
        "export const f=<T,>(value:T):T=>value;",
        "export const f=(x=(y)=>y)=>x(2);",
        "#!/usr/bin/env node\n/* @__PURE__ */ export const f=()=>/a<b>/.test('a<b>');",
        "export const text=`한글😀${1}`; export const value=0xFF+1_000+1e2;",
    ] {
        let result = compilation(source);
        assert_eq!(result["ok"], true, "{source}: {result}");
    }
    for source in [
        "export const f=([(a)])=>a;",
        "export const f=({a=1});",
        "export const f=(...a,b)=>a;",
    ] {
        assert_eq!(compilation(source)["ok"], false, "{source}");
    }
}
