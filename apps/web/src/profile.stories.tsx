import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { NameForm } from './profile.tsx';

/**
 * Choosing a display name (AUTH-05). Checked in the browser first; outside a ProfileProvider the
 * save always succeeds.
 */
const meta = {
  title: 'Account/NameForm',
  component: NameForm,
  args: { submitLabel: 'Save', onDone: fn() },
} satisfies Meta<typeof NameForm>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** After the first sign-in, with a way to put it off. */
export const FirstSignIn: Story = {
  args: {
    submitLabel: 'Choose this name',
    children: (
      <button type="button" className="button">
        Later
      </button>
    ),
  },
};
