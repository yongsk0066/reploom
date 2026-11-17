use oxc_parser::ParseOptions;

/// Keep preparation and browser edits on the same bounded grammar policy.
/// Lookahead must start before the recursion budget so flat comparison lists
/// can reject impossible generic parses without exhausting the budget.
pub(crate) fn options() -> ParseOptions {
    ParseOptions {
        type_argument_lookahead_depth: 16,
        max_type_depth: 32,
        ..Default::default()
    }
}
