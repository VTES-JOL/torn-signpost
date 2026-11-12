import type { Preview } from '@storybook/react-vite';
import { StoryProviders } from '../src/stories/fixtures.tsx';
import '../src/styles.css';

const preview: Preview = {
  decorators: [
    (Story, { parameters }) => (
      <StoryProviders flags={parameters.flags}>
        <Story />
      </StoryProviders>
    ),
  ],
  parameters: {
    controls: { expanded: true },
  },
};

export default preview;
