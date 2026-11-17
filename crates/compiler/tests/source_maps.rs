use oxc_sourcemap::{ConcatSourceMapBuilder, SourceMap, SourceMapBuilder, Token};

fn reference(map: SourceMap<'_>, offset: u32) -> String {
    let mut parts = map.into_parts();
    for token in &mut parts.tokens {
        *token = Token::new(
            token.get_dst_line() + offset,
            token.get_dst_col(),
            token.get_src_line(),
            token.get_src_col(),
            token.get_source_id(),
            token.get_name_id(),
        );
    }
    parts.token_chunks = None;
    SourceMap::from_parts(parts).to_json_string()
}

fn sample() -> SourceMap<'static> {
    let mut builder = SourceMapBuilder::default();
    let source = builder.add_source_and_content("/한글.ts", "// 😀\r\nconst 값 = '😀';\n\n");
    let name = builder.add_name("값");
    builder.add_token(0, 0, 1, 6, Some(source), Some(name));
    builder.add_token(0, 8, 0, 3, Some(source), None);
    builder.add_token(3, 0, 0, 0, None, None);
    builder.add_token(9, 4, 1, 11, Some(source), Some(name));
    builder.into_sourcemap()
}

#[test]
fn writer_offset_matches_rewritten_tokens_without_mutating_the_map() {
    for map in [SourceMap::default(), sample()] {
        let original = map.to_json_string();
        for offset in [0, 1, 7, 4096] {
            assert_eq!(
                map.to_json_string_with_generated_line_offset(offset),
                reference(map.clone(), offset)
            );
        }
        assert_eq!(map.to_json_string(), original);
    }
}

#[test]
fn writer_offset_preserves_concatenated_chunk_state() {
    let first = sample();
    let second = sample();
    let mut concat = ConcatSourceMapBuilder::default();
    concat.add_sourcemap(&first, 0);
    concat.add_sourcemap(&second, 20);
    let map = concat.into_sourcemap();
    for offset in [0, 1, 31] {
        assert_eq!(
            map.to_json_string_with_generated_line_offset(offset),
            reference(map.clone(), offset)
        );
    }
}
