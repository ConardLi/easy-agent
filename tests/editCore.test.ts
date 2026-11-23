import { applyEditToContent } from '../src/tools/editCore';

describe('applyEditToContent', () => {
  it('should apply edit without normalizing new_string', () => {
    const content = "const x = 'hello';";
    const edit = {
      old_string: "'hello'",
      new_string: "“world”"
    };
    const result = applyEditToContent(content, edit);
    expect(result).toBe("const x = “world”;");
  });

  it('should normalize old_string for matching', () => {
    const content = "const x = 'hello';";
    const edit = {
      old_string: "‘hello’",
      new_string: "'world'"
    };
    const result = applyEditToContent(content, edit);
    expect(result).toBe("const x = 'world';");
  });
});
