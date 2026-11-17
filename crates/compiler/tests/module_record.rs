use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_span::SourceType;
use oxc_syntax::module_record::{ExportImportName, ExportLocalName};

#[test]
fn indexed_exports_preserve_namespaces_defaults_types_and_order() {
    let allocator = Allocator::default();
    let parsed = Parser::new(
        &allocator,
        "import def from 'a'; import * as ns from 'b'; import {x as local} from 'c';
         import type {T} from 'types'; export {def as d, ns, local as v}; export type {T};
         export const own = 1; export * from 'star';",
        SourceType::ts(),
    )
    .parse();
    assert!(parsed.diagnostics.is_empty());
    let record = parsed.module_record;
    assert_eq!(record.local_export_entries.len(), 1);
    assert_eq!(record.star_export_entries.len(), 1);
    let exports = &record.indirect_export_entries;
    assert_eq!(exports.len(), 4);
    for (entry, source) in exports.iter().zip(["a", "b", "c", "types"]) {
        assert_eq!(entry.module_request.as_ref().unwrap().name, source);
        assert!(matches!(entry.local_name, ExportLocalName::Null));
    }
    assert!(
        matches!(&exports[0].import_name, ExportImportName::Name(name) if name.name == "default")
    );
    assert!(exports[1].import_name.is_all());
    assert!(matches!(&exports[2].import_name, ExportImportName::Name(name) if name.name == "x"));
    assert!(exports[3].is_type);
}

#[test]
fn duplicate_import_names_keep_the_first_declaration_before_diagnostics() {
    let allocator = Allocator::default();
    let source =
        "import {x as local} from 'first'; import {y as local} from 'second'; export {local}";
    let parsed = Parser::new(&allocator, source, SourceType::mjs()).parse();
    let entry = &parsed.module_record.indirect_export_entries[0];
    assert_eq!(entry.module_request.as_ref().unwrap().name, "first");
    assert!(matches!(&entry.import_name, ExportImportName::Name(name) if name.name == "x"));
    let semantic = oxc_semantic::SemanticBuilder::new_compiler().build(&parsed.program);
    assert!(!semantic.diagnostics.is_empty());
}

#[test]
fn modules_without_exports_retain_their_import_records() {
    let allocator = Allocator::default();
    let parsed = Parser::new(
        &allocator,
        "import {x} from 'a'; import 'side-effect'; console.log(x);",
        SourceType::mjs(),
    )
    .parse();
    assert!(parsed.diagnostics.is_empty());
    let record = parsed.module_record;
    assert_eq!(record.import_entries.len(), 1);
    assert_eq!(record.requested_modules.len(), 2);
    assert!(record.local_export_entries.is_empty());
    assert!(record.indirect_export_entries.is_empty());
}

#[test]
fn dense_exports_keep_local_and_reexported_bindings_distinct() {
    let allocator = Allocator::default();
    let mut source = String::new();
    for i in 0..4000 {
        source.push_str(&format!(
            "import {{x as x{i}}} from './dep'; export {{x{i} as re{i}}}; export const local{i} = x{i};\n"
        ));
    }
    let parsed = Parser::new(&allocator, &source, SourceType::mjs()).parse();
    assert!(parsed.diagnostics.is_empty());
    let record = parsed.module_record;
    assert_eq!(record.import_entries.len(), 4000);
    assert_eq!(record.indirect_export_entries.len(), 4000);
    assert_eq!(record.local_export_entries.len(), 4000);
    assert!(record.star_export_entries.is_empty());
    for entry in &record.indirect_export_entries {
        assert_eq!(entry.module_request.as_ref().unwrap().name, "./dep");
        assert!(matches!(&entry.import_name, ExportImportName::Name(name) if name.name == "x"));
    }
}
