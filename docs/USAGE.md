# Using the IMDF Builder

A practical walkthrough for turning a floor plan into IMDF files that Microsoft
Places will accept. Read the order of work first — most export problems come
from doing step 5 before step 3.

---

## Order of work

1. **Name the project and the building.**
2. **Upload the floor plan** (PDF, PNG, JPG or SVG).
3. **Georeference the plan**: set the venue coordinates, calibrate the scale,
   then set the anchor point. *Do this before you draw anything.*
4. **Add your levels.**
5. **Draw units, amenities, fixtures and openings.**
6. **Fill in the properties** for each item (name, category, Exchange ID).
7. **Export.**

You can draw before georeferencing, and the drawing will not be lost — but every
exported coordinate depends on the georeference, so set it early and avoid
re-checking the whole plan later.

---

## 1. Georeferencing (the part that matters most)

IMDF is a geographic format. Every room you draw has to land on the real world at
real size. Three numbers do that:

| Control | What it means |
|---|---|
| **Venue Coordinates** | The latitude and longitude of the **anchor point** — not the centre of the building. |
| **Scale (metres per pixel)** | How big one canvas pixel is on the ground. |
| **Rotation** | How many degrees to turn the plan clockwise so that plan-up points at true north. |

### Set the anchor on something you can identify

Click **⌖ Set Anchor Point**, then click a feature on the plan whose real-world
coordinates you actually know — a building corner, a main entrance, a surveyed
column. Then paste that feature's latitude and longitude into **Venue
Coordinates**.

Picking "roughly the middle of the building" is the most common source of a map
that is 20 m out. Use a corner.

To get the coordinates: open the location in Google Maps or Apple Maps,
right-click (or long-press) the exact corner, and copy the `lat, lon` pair.

### Calibrate the scale from a known distance

Click **⟷ Calibrate from Two Points**, click the two ends of something whose real
length you know, and type that length in metres. Good choices, best first:

1. The scale bar printed on the architectural drawing.
2. A dimension line already annotated on the plan.
3. A standard door — a single leaf is ~0.9 m, a double ~1.8 m.
4. The overall façade length taken from the Google Maps measure tool.

The readout under the Georeferencing heading shows `● Calibrated — 1 px = 0.0500 m`
once this is done. If it still says `○ Not calibrated`, the export will warn you.

### Rotation

If the plan's "up" is not true north, enter the clockwise angle that would turn it
to north. A plan drawn with north to the right needs `270`.

---

## 2. Levels

Click **Add Level** for each floor. The **ordinal** is what Places uses to stack
them:

- Ground floor → `0`
- First floor above ground → `1`
- Basement → `-1`

With more than one level, the canvas only shows the items on the level you have
selected, so levels do not visually collide.

### Multi-page PDFs — one level per page

Upload a PDF with several pages and the builder offers a page picker. You can
either pick a single page to trace, or click **Create one level per page** to
generate a level per page in one go, each remembering its own page of the plan.

Pages are assigned ordinals `0, 1, 2 …` in page order, so if your PDF leads with a
site plan or a cover sheet, delete that level afterwards and renumber.

---

## 3. Drawing

| Tool | Use for | Produces |
|---|---|---|
| ✏ **Draw Unit (Polygon)** | Any room shape, including L-shaped, T-shaped and curved-ish rooms | `unit` |
| ▭ **Place Unit (Rectangle)** | Quick rectangular rooms | `unit` |
| ● **Place Amenity** | Toilets, lifts, stairs, reception points | `amenity` |
| — **Place Fixture** | Walls, columns, fixed furniture | `fixture` |
| ⌗ **Place Opening (Door)** | Doors and doorways | `opening` |

### L-shaped and irregular rooms

Use **Draw Unit (Polygon)**: click each corner in turn, then click the first point
again (or double-click) to close the shape. There is no vertex limit.

After closing, select the room and drag any of its vertex handles to adjust it —
so you can trace roughly and then tidy up. Edges snap to nearby walls on the
underlying plan image.

### Rooms that need a hole in them

Draw the outer room as one unit, then draw the inner void as a second unit and
set its category appropriately. IMDF does not represent a room with a hole as a
single feature in this builder.

---

## 4. Properties and Exchange IDs

Select an item and fill in the properties panel.

**Exchange ID** is the field that connects a room to Microsoft Places. It is the
room mailbox's primary SMTP address — `room-3-12@contoso.com` — and it must match
the mailbox exactly, or Places will show the room as unmapped. Leave it blank for
corridors, lobbies and anything with no mailbox.

Set a **category** on every unit. `room`, `office`, `conferenceroom`, `restroom`,
`elevator`, `stairs`, `walkway` and `lobby` cover most plans.

---

## 5. Address

Fill in the Address panel. IMDF requires an `address.geojson`, and Places uses it
to place the venue. Street, locality (suburb/city), province (state) and country
code are the fields that matter; the country is a two-letter ISO code — `AU`,
`US`, `GB`.

---

## 6. Pre-export checklist

- [ ] Georeference says **● Calibrated**, and the anchor is on a known feature.
- [ ] Venue coordinates are not `0, 0`.
- [ ] At least one level exists, with sensible ordinals.
- [ ] Every room mailbox has its Exchange ID set.
- [ ] Every unit has a category.
- [ ] Address fields are filled in.

The export button warns you about the first two before producing a file.

---

## 7. What you get

A zip with the 16 IMDF files Places expects. The ones worth checking:

| File | What it should contain |
|---|---|
| `footprint.geojson` | The building outline polygon. **Must not be empty.** |
| `building.geojson` | The building — with `"geometry": null`. That is correct per the IMDF spec; the shape lives in `footprint.geojson`. |
| `venue.geojson` | A polygon around the site, with a display point. |
| `level.geojson` | One polygon per level. |
| `unit.geojson` | One polygon per room. |

A quick sanity check: open `unit.geojson` at <https://geojson.io> and confirm your
rooms land on the right building at the right size. If they are the wrong size,
re-calibrate the scale; if they are in the wrong place, re-check the anchor.

---

## 8. Saving and loading

**Save Project** stores the full canvas geometry, not just the exported
coordinates, so reloading gives you back exactly what you drew — including
polygon shapes, fixtures and openings.

Projects saved by versions before 1.4.0 are still loadable: their rooms are
rebuilt by re-projecting the stored IMDF coordinates. Check the shapes after
loading an old project, then re-save it to move it to the current format.
