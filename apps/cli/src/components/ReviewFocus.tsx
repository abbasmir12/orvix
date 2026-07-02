import React from "react";
import { Box, Text } from "ink";
import { theme } from "../lib/theme.js";
import type { PullRequest } from "../types.js";

type ReviewFocusProps = {
  pullRequests: PullRequest[];
};

export function ReviewFocus({ pullRequests }: ReviewFocusProps) {
  const focused =
    pullRequests.find((pr) => pr.status === "Changes requested") ??
    pullRequests.find((pr) => pr.status === "In progress") ??
    pullRequests[pullRequests.length - 1];

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} paddingY={1} marginBottom={1}>
      <Text color={theme.accent} bold>
        Review Focus
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color="gray">Target:</Text> PR #{focused.id} · {focused.title}
        </Text>
        <Text>
          <Text color="gray">Branch:</Text> {focused.branch}
        </Text>
        <Text>
          <Text color="gray">Owner:</Text> {focused.ownerName}
        </Text>
        <Text>
          <Text color="gray">Gate:</Text>{" "}
          <Text color={focused.status === "Changes requested" ? "yellow" : focused.status === "Approved" ? "green" : "cyan"}>
            {focused.reviewerStatus}
          </Text>
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">Reviewer Signal:</Text>
          {focused.comments.length > 0 ? (
            focused.comments.slice(-2).map((comment) => (
              <Text key={comment}>
                <Text color="yellow">! </Text>
                {comment}
              </Text>
            ))
          ) : (
            <Text color="gray">No blocking comments yet.</Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}
