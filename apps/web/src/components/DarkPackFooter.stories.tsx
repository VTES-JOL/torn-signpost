import type { Meta, StoryObj } from '@storybook/react-vite';
import { DarkPackFooter } from './DarkPackFooter.tsx';

/** The footer on every page, with the notices the Dark Pack Agreement requires (LEGAL-01..03). */
const meta = {
  title: 'Layout/DarkPackFooter',
  component: DarkPackFooter,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof DarkPackFooter>;
export default meta;

type Story = StoryObj<typeof meta>;

/** The logo comes from the content pack, never the app bundle (LEGAL-08). */
export const WithLogo: Story = { args: { contentUrl: '/content' } };

/** No content origin, or the logo failed to load: a text badge instead. */
export const WithoutLogo: Story = { args: { contentUrl: undefined } };
