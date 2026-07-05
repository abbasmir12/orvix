import React from "react";
import { Box, Text } from "ink";
import { theme } from "../lib/theme.js";

const mark = [
  "   ▄██████▄  ▄████████  ███    ███  ▄█  ▀████    ▐████▀",
  "  ███    ███ ███    ███ ███    ███ ███    ███▌   ████▀ ",
  "  ███    ███ ███    ███  ███  ███  ███     ███  ▐███   ",
  "  ███    ███ ████████▀    ██████   ███     ▀███▄███▀   ",
  "  ███    ███ ███   ███     ████    ███     ████▀██▄    ",
  "  ███    ███ ███    ███     ██     ███    ▐███  ▀███   ",
  "   ▀██████▀  ███    ███      ▀     █▀    ▄████    ███▄ ",
  "     ══╡ Self-organizing AI engineering company ╞══"
];

type BrandMarkProps = {
  compact?: boolean;
};

export function BrandMark({ compact = false }: BrandMarkProps) {
  if (compact) {
    return (
      <Text color={theme.accent} bold>
        ORVIX
      </Text>
    );
  }

  return (
    <Box flexDirection="column" alignItems="center">
      {mark.map((line) => (
        <Text key={line} color={theme.accent} bold>
          {line}
        </Text>
      ))}
    </Box>
  );
}
