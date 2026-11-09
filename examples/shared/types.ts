/** Only this public presentation projection is sent to the browser. */
export type ExamplePresentation = {
  heading: string;
  introduction: string;
  assistantLabel: string;
  starters: { category: string; text: string }[];
};
