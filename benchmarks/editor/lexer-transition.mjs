export const scalarTransition = `                state = data[index + 2];
                input.advance();`;

export const inlineTransition = `                let target = data[index + 2], count = 1;
                if (target == state) {
                    let {chunk, chunkOff} = input;
                    // A self-edge repeats the same acceptance decision. Scan its
                    // character interval once, bounded by the current input chunk.
                    while (chunkOff + count < chunk.length) {
                        let next = chunk.charCodeAt(chunkOff + count);
                        if (next < from || next >= to) break;
                        count++;
                    }
                    // advance() returns early at EOF; retain the same dependency
                    // on all consumed input that scalar advancement would record.
                    if (input.pos + count > input.token.lookAhead)
                        input.token.lookAhead = input.pos + count;
                }
                state = target;
                input.advance(count);`;

export const batchedTransition = `                let target = data[index + 2], count = 1;
                if (target == state) {
                    count = scanCharacterRun(input.chunk, input.chunkOff, from, to);
                    // advance() returns early at EOF; retain the same dependency
                    // on all consumed input that scalar advancement would record.
                    if (input.pos + count > input.token.lookAhead)
                        input.token.lookAhead = input.pos + count;
                }
                state = target;
                input.advance(count);`;

export const characterRun = `// Keep the stable string scan separate from the token-state interpreter so
// engines can optimize its loop independently of the parser's other branches.
function scanCharacterRun(chunk, offset, from, to) {
    let end = offset + 1, length = chunk.length;
    while (end < length) {
        let code = chunk.charCodeAt(end);
        if (code < from || code >= to) break;
        end++;
    }
    return end - offset;
}
`;
