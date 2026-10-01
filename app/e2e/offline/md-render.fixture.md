# Bioxentys thread (Malta time)

---

**Shikher -> Bioxentys**, 30 Sep 07:01

A plain paragraph with **bold**, *italic*, ***bold italic***, ~~struck~~, `inline code`, and a [link](https://example.com/docs). A bare URL https://example.com/a/very/long/path/that/keeps/going/and/going/to/test/wrapping/in/the/viewer too.
A second line in the same paragraph, after a single newline.  
A hard break (two trailing spaces) ends the line above.

HTML entities: &amp; &lt;tag&gt; &copy; 2026 &mdash; &nbsp;done &#8364;5 &#x2713;

## Heading two

### Heading three

#### Heading four

##### Heading five

###### Heading six

---

```ts
// a fenced block with a language
export function greet(name: string): string {
  return `hello ${name}, this line is deliberately long so that it overflows the page width and must scroll horizontally inside the block`;
}
```

```
a fenced block without a language
    indented inside the fence
```

    indented code block line one
    indented code block line two, also long enough to need horizontal scrolling inside its own block rather than the page

> A blockquote paragraph that runs long enough to wrap onto a second line on a phone, with **bold** and `code` inside.
>
> A second paragraph in the same quote.
>
> > A nested quote, one level deeper.
>
> - a list inside the quote
> - second item

1. First ordered
2. Second ordered
   - nested bullet
   - another nested bullet
     1. deeper ordered
3. Third ordered

- Unordered one
- Unordered two
  - nested two-a
- Unordered three

- [ ] an open task
- [x] a done task

| Column one | Column two | Column three | Column four | Column five | Column six | Column seven |
|:-----------|:----------:|-------------:|-------------|-------------|------------|--------------|
| left | center | right | a cell with quite a lot of text in it | `code` | **bold** | the last column |
| two | 2 | 2.00 | short | more | text | end |

![an image alt text](https://example.com/picture.png)

Final paragraph after everything.
