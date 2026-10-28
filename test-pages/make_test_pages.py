"""Make the test pages for the preview's test login (publish.py builds them as the "Tester" version).

They exist to try the wiki where real pages don't reach yet: a tree longer than any player's,
deep folders (with an overview note beside a folder), a very long page, a very long title, wide
tables and unbroken words, and "Questions" sections for the Answer buttons. Add or change pages
here, run this again, then publish.py and deploy the preview. Never shown on the live site.

Usage (from this folder):  python make_test_pages.py
"""
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
LOREM = ("The lanterns sway between the tents while the calliope plays a tune nobody remembers learning. "
         "A snail in a tiny saddle waits patiently at the starting line, and somewhere a bell rings twice.")


def page(rel, body):
    path = os.path.join(HERE, *rel.split("/")) + ".md"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(body.strip() + "\n")


def main():
    for entry in os.listdir(HERE):
        full = os.path.join(HERE, entry)
        if os.path.isdir(full):
            shutil.rmtree(full)
        elif entry.endswith(".md"):
            os.remove(full)

    for i in range(1, 46):
        page(f"Many pages/Test page {i:02d}", f"Test page number {i}.\n\n{LOREM}")

    page("Deep/Level 1", "An overview note beside its folder: one entry that opens and folds out.")
    page("Deep/Level 1/Level 2/Level 3/Level 4/A page deep down", f"Five folders down.\n\n{LOREM}")
    page("Deep/Level 1/Level 2/Another page", LOREM)

    page("A page with a very long title that keeps going and going to see what the sidebar does with it",
         "The title is the test.")

    sections = []
    for i in range(1, 41):
        sections.append(f"## Section {i}\n\n{LOREM}\n\n{LOREM}\n\n- A point\n- Another point")
    page("Long page", "A very long page, to scroll past the floating button and the sidebar.\n\n" + "\n\n".join(sections))

    page("Questions page", """
Answer buttons belong under every point of a section whose heading starts with "Questions".

## Questions for the tester
- **A short question:** what does your character carry in their pockets?
- **A new question:** where did your character sleep last night?
- **A long question:** """ + LOREM + " " + LOREM + """
- **A question with a list inside it:** which of these?
  - the lantern
  - the bell

## Not questions
- This list gets no Answer buttons.
""")

    head = "| " + " | ".join(f"Column {i}" for i in range(1, 13)) + " |"
    rule = "|" + "---|" * 12
    row = "| " + " | ".join("some longer cell text" for _ in range(12)) + " |"
    page("Wide things", f"""
A wide table:

{head}
{rule}
{row}
{row}

An unbroken word: Supercalifragilisticexpialidocious-and-then-some-more-without-any-spaces-at-all-to-break-on-anywhere.

A long line of code:

```
const aVeryLongLineOfCodeThatDoesNotWrap = "and keeps going far past the edge of any phone screen you might have";
```
""")
    print("Test pages made.")


if __name__ == "__main__":
    main()
