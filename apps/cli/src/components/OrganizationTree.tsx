import React from "react";
import { Box, Text } from "ink";
import { theme } from "../lib/theme.js";
import type { OrganizationNode } from "../types.js";

type OrganizationTreeProps = {
  organization: OrganizationNode;
};

function TreeNode({
  node,
  prefix = "",
  isLast = true,
  isRoot = false
}: {
  node: OrganizationNode;
  prefix?: string;
  isLast?: boolean;
  isRoot?: boolean;
}) {
  const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
  const childPrefix = isRoot ? "" : `${prefix}${isLast ? "   " : "│  "}`;

  return (
    <>
      <Text>
        <Text color={isRoot ? "white" : "gray"}>{prefix}</Text>
        <Text color="gray">{connector}</Text>
        <Text>{node.name}</Text>
      </Text>
      {node.children?.map((child, index) => (
        <TreeNode
          key={child.id}
          node={child}
          prefix={childPrefix}
          isLast={index === (node.children?.length ?? 0) - 1}
        />
      ))}
    </>
  );
}

export function OrganizationTree({ organization }: OrganizationTreeProps) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} paddingY={1} marginBottom={1}>
      <Text color={theme.accent} bold>
        Organization
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <TreeNode node={organization} isRoot />
      </Box>
    </Box>
  );
}
