# Overbrew

Overbrew adds brewable potions for effects that are normally unavailable and a Resin Clump modifier that removes potion particles.

Added effects support every configured potion form. Variant, conversion, cross-effect, and global-modifier recipes are generated from `src/generator/config.json`.

## Using the generator

Install the development dependencies:

```bash
bun install
```

Generate with the default config:

```bash
bun run generate
```

Generate with another config:

```bash
bun src/generator/index.ts path/to/config.json
```

Config-relative paths are resolved from the selected config file.

The generator recreates only the brewing recipes, generated item-tag folders, and vanilla tipped-arrow recipe it owns. Other datapack files are preserved. Before finishing, it validates generated recipe structures, generated item-tag references, and generation counts. Generated data is ignored by Git, so run the generator before testing or packaging the datapack.

## Config layout

```text
target       Target Minecraft and data-pack versions
generator    Generation, tag, output, and manifest settings
namespaces   Custom and vanilla namespaces
forms        Potion item forms
bases        Base-potion brews
modifiers    Reusable brewing modifiers
custom       Overbrew effects and transformations
vanilla      Vanilla potion states and transformations
```

The default config starts like this:

```json
{
  "target": {
    "data_pack_version": 110.0
  },
  "generator": {
    "include_vanilla_recipes": true,
    "preserve_imbued_components": true,
    "item_tags": {
      "enabled": true,
      "root": "brewing",
      "auto_generate": ["base", "effect", "modifier"],
      "rules": []
    },
    "output": {
      "root": "../datapack/data"
    }
  }
}
```

## Generator settings

### Vanilla recipes

```json
{
  "include_vanilla_recipes": true
}
```

When enabled, the generator reconstructs vanilla brewing recipes under the configured vanilla namespace and routes their reagents through the item-tag system.

When disabled, Overbrew recipes and configured global-modifier chains are still generated, but vanilla recipe files are not written.

### Component-preserving tipped arrows

```json
{
  "preserve_imbued_components": true
}
```

This setting defaults to `true`. It replaces the vanilla `tipped_arrow.json` recipe with a `crafting_transmute` recipe that combines one configured lingering-potion item with eight arrows and produces eight tipped arrows.

The transmutation copies the lingering potion's components to the arrows, allowing custom potion contents, colors, lore, and other compatible components to survive crafting. The generated output removes `minecraft:custom_name` so the result uses the tipped-arrow name instead of the potion name.

The replacement is written to:

```text
data/<vanilla namespace>/recipe/tipped_arrow.json
```

The configured `lingering` form must exist while this setting is enabled. Set the option to `false` to omit the replacement recipe.

### Output

```json
{
  "output": {
    "root": "../datapack/data",
    "manifest": "../../../dist/generator-manifest.json"
  }
}
```

- `root` points to the datapack's `data` folder.
- `manifest` is optional and writes the same generation summary printed to standard output.

The summary includes resolved namespace paths, per-stage generation counts, the validated recipe total, and the generated item-tag total. Both paths are relative to the config file.

## Brew maps

Bases, custom effects, and directly brewed vanilla potions use the same input-to-reagent map:

```json
{
  "brew": {
    "awkward": {
      "items": ["minecraft:golden_apple"]
    }
  }
}
```

This means:

```text
Awkward Potion + Golden Apple -> configured output
```

Several input potions may create the same output:

```json
{
  "brew": {
    "awkward": {
      "items": ["minecraft:golden_apple"]
    },
    "thick": {
      "items": ["minecraft:enchanted_golden_apple"]
    }
  }
}
```

Each input receives a separate recipe for every configured potion form.

## Reagents

A reagent defines the accepted item values and optional tag behavior:

```json
{
  "items": ["minecraft:redstone"]
}
```

Several items can share one reagent tag:

```json
{
  "items": ["minecraft:redstone", "minecraft:redstone_block"]
}
```

A brewing recipe can reference only one item or one item tag. A multi-item reagent therefore needs an enabled tag or another generated tag that wraps it.

### Reagent-owned tags

Reagent values are defined beside the base, effect, or modifier that owns them. Their default singular paths are:

```text
base/<id>
effect/<id>
modifier/<id>
```

With the default root, examples are:

```text
#overbrew:brewing/base/awkward
#overbrew:brewing/effect/absorption
#overbrew:brewing/modifier/extended
```

The optional `tag` key controls the reagent's own tag.

```json
{
  "items": ["minecraft:redstone"],
  "tag": true
}
```

```json
{
  "items": ["minecraft:redstone"],
  "tag": false
}
```

```json
{
  "items": ["minecraft:redstone"],
  "tag": "modifier/duration"
}
```

```json
{
  "items": ["minecraft:redstone"],
  "tag": {
    "enabled": true,
    "path": "modifier/duration",
    "replace": false
  }
}
```

When `tag` is omitted, the default tag is enabled when its category appears in `generator.item_tags.auto_generate`.

When a tag is disabled, references to it are flattened to its configured items or nearest enabled parent tag. The final recipe reference must still resolve to exactly one item or tag.

## Item-tag generation

```json
{
  "item_tags": {
    "enabled": true,
    "root": "brewing",
    "auto_generate": ["base", "effect", "modifier"],
    "rules": []
  }
}
```

### Settings

| Key             | Behavior                                      |
| --------------- | --------------------------------------------- |
| `enabled`       | Enables generated reagent tags globally.      |
| `root`          | Sets the generated path below `tags/item`.    |
| `auto_generate` | Adds ordered automatic tag layers.            |
| `rules`         | Adds a final tag to matching recipe contexts. |

If `enabled` is `false`, every recipe must resolve to one direct item.

### Automatic families

Only these exact singular values are accepted:

| Family       | Example                                              | Applies to                  |
| ------------ | ---------------------------------------------------- | --------------------------- |
| `base`       | `base/awkward`                                       | Base-potion brews           |
| `effect`     | `effect/absorption`                                  | Direct effect brews         |
| `modifier`   | `modifier/extended`                                  | Modifier reagents           |
| `variant`    | `variant/absorption_to_long_absorption`              | Same-effect variant changes |
| `convert`    | `convert/leaping_to_slowness`                        | Cross-effect changes        |
| `conversion` | `conversion/regular_to_splash`                       | Potion-form changes         |
| `recipe`     | `recipe/custom/absorption/modifier/extended/regular` | Individual recipe contexts  |

Order matters. Each applicable family wraps the previously resolved reagent reference. Only tags referenced by generated recipes are written.

```json
{
  "auto_generate": ["modifier", "variant", "recipe"]
}
```

can create:

```text
recipe/custom/absorption/modifier/extended/regular
└── variant/absorption_to_long_absorption
    └── modifier/extended
        └── minecraft:redstone
```

### Rules

Rules are checked in declaration order. The first matching rule wins.

```json
{
  "rules": [
    {
      "path": "modifier/extended/swiftness",
      "values": ["$auto", "minecraft:redstone_block"],
      "match": {
        "effect": "swiftness",
        "modifier": "extended"
      }
    }
  ]
}
```

Use `matches` for alternative match objects:

```json
{
  "path": "modifier/speed_duration",
  "values": ["$default"],
  "matches": [
    {
      "effect": "swiftness",
      "modifier": "extended"
    },
    {
      "effect": "haste",
      "modifier": "extended"
    }
  ]
}
```

Rule values:

| Value               | Meaning                                                  |
| ------------------- | -------------------------------------------------------- |
| `$default`          | The reagent's base, effect, or modifier tag              |
| `$auto`             | The most specific automatic tag resolved before the rule |
| `minecraft:item_id` | A direct item                                            |
| `#namespace:path`   | An external item tag                                     |
| `#local/path`       | A generated tag below the configured root                |

Available match keys:

```text
source
input
output
input_form
output_form
effect
variant
modifier
category
recipe
operation
recipe_key
input_particles
output_particles
```

A match value may be a string, number, boolean, or array. Arrays use OR behavior.

A rule path matching `convert/<input>_to_<output>` may omit its matcher. The generator then infers base, long, and strong input/output variants where applicable.

## Base potions

```json
{
  "bases": {
    "awkward": {
      "brew": {
        "water": {
          "items": ["minecraft:nether_wart"]
        }
      }
    }
  }
}
```

The object key is the output potion ID and default base tag ID.

Configured bases are also included in the automatically derived list of vanilla potions accepted by container conversions.

## Modifiers

Every modifier defines a reusable reagent and may define one behavior type.

### Variant transformation

```json
{
  "extended": {
    "reagent": {
      "items": ["minecraft:redstone"]
    },
    "variant_transform": {
      "from": "base",
      "to": "long"
    }
  }
}
```

This preserves the potion form and changes its variant.

For custom effects, a recipe is generated only when both variants exist. For vanilla potions, the generator derives IDs such as:

```text
base   -> swiftness
long   -> long_swiftness
strong -> strong_swiftness
```

The vanilla recipe is generated only when both derived state IDs are present under `vanilla.potions`.

### Container conversion

```json
{
  "splash": {
    "reagent": {
      "items": ["minecraft:gunpowder"]
    },
    "container_conversion": {
      "from": "regular",
      "to": "splash"
    }
  }
}
```

Both names must exist under `forms`.

Vanilla convertible potion IDs are derived from `water`, every configured base, and every configured vanilla potion state. No separate conversion list is required.

### Global modifier

```json
{
  "no_particles": {
    "reagent": {
      "items": ["minecraft:resin_clump"]
    },
    "global": {
      "apply_to": ["custom", "vanilla"],
      "input_show_particles": true,
      "output_show_particles": false,
      "components": {
        "minecraft:lore": [
          {
            "translate": "overbrew.lore.no_particles",
            "fallback": "No Particles",
            "italic": false,
            "color": "#FC7812"
          }
        ]
      }
    }
  }
}
```

| Key                     | Behavior                                                   |
| ----------------------- | ---------------------------------------------------------- |
| `apply_to`              | Selects `custom`, `vanilla`, or both. Defaults to both.    |
| `input_show_particles`  | Particle state required on the input. Defaults to `true`.  |
| `output_show_particles` | Particle state written to the output. Defaults to `false`. |
| `components`            | Adds, replaces, or removes output item components.         |

Example:

```json
{
  "components": {
    "minecraft:custom_data": {
      "overbrew": {
        "particle_free": true
      }
    },
    "minecraft:enchantment_glint_override": true
  }
}
```

The component patch is applied to the generated potion stack. A component value of `null` removes that component from the output.

A particle-hiding global modifier also receives compatible custom and vanilla transformation chains, allowing the modified potions to continue through configured variants, form conversions, and cross-effect transformations.

## Custom effects

```json
{
  "custom": {
    "effects": {
      "absorption": {
        "effect_id": "minecraft:absorption",
        "display": "Absorption",
        "translation_suffix": "absorption",
        "color": 2445989,
        "variants": {
          "base": {
            "duration": 3600,
            "amplifier": 0
          },
          "long": {
            "duration": 9600,
            "amplifier": 0
          },
          "strong": {
            "duration": 1800,
            "amplifier": 1
          }
        },
        "brew": {
          "awkward": {
            "items": ["minecraft:golden_apple"]
          }
        }
      }
    },
    "cross_effect_transforms": []
  }
}
```

| Key                  | Behavior                                              |
| -------------------- | ----------------------------------------------------- |
| Effect object key    | Stable effect ID used by recipe paths and tags        |
| `effect_id`          | Minecraft status-effect ID                            |
| `display`            | English fallback name                                 |
| `translation_suffix` | Final segment of the generated potion translation key |
| `color`              | Decimal custom potion color                           |
| `variants`           | Available states for the effect                       |
| `brew`               | Inputs and reagents that create the base state        |

### Variants

- `duration` is measured in ticks. There are 20 ticks per second.
- `amplifier` is zero-based. `0` is level I, `1` is level II, and `2` is level III.
- `base` is required for directly brewed custom effects.
- Other names are allowed when a modifier transforms to or from them.
- Missing target variants are skipped. An effect without `strong` receives no strengthening recipe.

### Names and translations

For regular Absorption, the generated custom name resembles:

```json
{
  "translate": "item.minecraft.potion.effect.absorption",
  "fallback": "Potion of Absorption",
  "italic": false
}
```

`translation_suffix` controls the final key segment. The selected form controls `potion`, `splash_potion`, or `lingering_potion`. `display` and the form's `fallback_prefix` create the fallback name.

A resource pack may define the translation key, while the fallback remains readable without it.

### Custom cross-effect transformations

```json
{
  "cross_effect_transforms": [
    {
      "id": "haste_to_mining_fatigue",
      "from_effect": "haste",
      "from_variant": "base",
      "to_effect": "mining_fatigue",
      "to_variant": "base",
      "modifier": "corrupting"
    }
  ]
}
```

- `id` is used in generated recipe paths.
- `from_variant` and `to_variant` default to `base`.
- `modifier` references a top-level modifier and uses its reagent.
- When no modifier key is provided, the transform's `id` is used as the modifier ID.

The source effect, target effect, selected variants, and modifier must exist.

## Vanilla potion model

```json
{
  "vanilla": {
    "potions": {
      "swiftness": {
        "display": "Swiftness",
        "translation_suffix": "swiftness",
        "color": 3402751,
        "effects": [
          {
            "id": "minecraft:speed",
            "duration": 3600,
            "amplifier": 0
          }
        ],
        "brew": {
          "awkward": {
            "items": ["minecraft:sugar"]
          }
        }
      },
      "long_swiftness": {
        "display": "Swiftness",
        "translation_suffix": "swiftness",
        "color": 3402751,
        "effects": [
          {
            "id": "minecraft:speed",
            "duration": 9600,
            "amplifier": 0
          }
        ]
      }
    },
    "cross_effect_transforms": []
  }
}
```

The potion object key is the exact vanilla potion state ID, such as `swiftness`, `long_swiftness`, or `strong_swiftness`.

| Key                  | Behavior                                              |
| -------------------- | ----------------------------------------------------- |
| `display`            | English fallback effect name                          |
| `translation_suffix` | Base suffix shared by normal, long, and strong states |
| `color`              | Decimal color used by global-modifier outputs         |
| `effects`            | Effect data used by predicates and generated outputs  |
| `brew`               | Optional direct recipe that creates this state        |

Effect entries use `id`, `duration`, and `amplifier`. Omitted amplifiers default to `0`; omitted durations default to `1` tick.

### Inferred variant recipes

Vanilla long and strong recipe mappings are inferred from configured variant modifiers and available state IDs. Separate transformation entries are unnecessary.

For example, a `base` to `long` modifier generates:

```text
swiftness -> long_swiftness
strength -> long_strength
leaping -> long_leaping
```

only where both states are configured.

### Vanilla cross-effect transformations

```json
{
  "cross_effect_transforms": [
    {
      "from": "leaping",
      "to": "slowness",
      "modifier": "corrupting"
    },
    {
      "from": "long_leaping",
      "to": "long_slowness",
      "modifier": "corrupting"
    }
  ]
}
```

`from` and `to` must be exact keys from `vanilla.potions`. `modifier` must reference an entry under the top-level `modifiers` object.

## Forms

```json
{
  "forms": {
    "regular": {
      "item": "minecraft:potion",
      "translation_item": "potion",
      "fallback_prefix": "Potion of "
    },
    "splash": {
      "item": "minecraft:splash_potion",
      "translation_item": "splash_potion",
      "fallback_prefix": "Splash Potion of "
    },
    "lingering": {
      "item": "minecraft:lingering_potion",
      "translation_item": "lingering_potion",
      "fallback_prefix": "Lingering Potion of "
    }
  }
}
```

- `item` is the Minecraft potion item ID.
- `translation_item` is used in generated translation keys.
- `fallback_prefix` is prepended to the effect's fallback display name.

Direct custom brews and same-form transformations are generated for every configured form. Container modifiers define transitions between forms.

## Namespaces and target metadata

```json
{
  "namespaces": {
    "custom": "overbrew",
    "vanilla": "minecraft"
  },
  "target": {
    "data_pack_version": 110.0
  }
}
```

- `namespaces.custom` controls Overbrew recipe and tag locations.
- `namespaces.vanilla` controls vanilla resources, recipe types, and reconstructed recipes.
- `target.data_pack_version` records the intended data-pack version.

Use complete resource locations in the config. Unnamespaced values use the configured vanilla namespace.

## Common changes

### Add another valid modifier item

```json
{
  "reagent": {
    "items": ["minecraft:redstone", "minecraft:redstone_block"]
  }
}
```

### Change one effect's brewing ingredient

```json
{
  "brew": {
    "awkward": {
      "items": ["minecraft:diamond"]
    }
  }
}
```

### Generate conversion-specific tags

```json
{
  "auto_generate": ["base", "effect", "modifier", "convert", "conversion"]
}
```

This can produce tags such as:

```text
#overbrew:brewing/convert/leaping_to_slowness
#overbrew:brewing/conversion/regular_to_splash
```

## Configuration errors

Generation stops when the config is ambiguous or invalid, including:

- unknown forms or modifiers
- empty reagent item lists
- missing cross-effect states
- conflicting settings for one tag path
- generated tag cycles
- unsupported `auto_generate` names
- rules without a matcher or inferable `convert` path
- disabled tags that resolve to more than one direct item
- duplicate generated recipe paths
- component-preserving tipped arrows enabled without a configured `lingering` form

Fix the reported entry and run the generator again.

## License

Overbrew is licensed under the [Smidul Bundle and Addon License 1.0](./LICENSE).
