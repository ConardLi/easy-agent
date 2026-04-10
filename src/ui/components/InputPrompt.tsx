import React from "react";
import { Box, Text } from "ink";

interface InputPromptProps {
  isLoading: boolean;
  inputValue: string;
}

export function InputPrompt({ isLoading, inputValue }: InputPromptProps): React.ReactNode {
  if (isLoading) {
    return null;
  }

  return (
    <Box marginTop={1}>
      <Text color="green" bold>{"❯ "}</Text>
      <Text>{inputValue}</Text>
      <Text dimColor>{"\u258B"}</Text>
    </Box>
  );
}
