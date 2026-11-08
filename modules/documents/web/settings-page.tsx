import { saveProfileAction } from "./actions.ts";
import { ProfileForm } from "./forms.tsx";
import { logFailure } from "./log.ts";
import { PageBar } from "./nav.tsx";
import { Unavailable } from "./page-state.tsx";

const DESCRIPTION = "Your company data, branding and default terms, filled into every template that uses them.";

/** The owner profile page for the form values `load` returns (every profile field, blank when not set). */
export async function renderSettingsPage(load: () => Promise<Record<string, string>>) {
  let values: Record<string, string>;
  try {
    values = await load();
  } catch (error) {
    logFailure("could not load the profile", error);
    return (
      <div>
        <PageBar title="Owner profile" description={DESCRIPTION} current="profile" />
        <div className="page-body">
          <Unavailable title="The profile is unavailable" error={error} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageBar title="Owner profile" description={DESCRIPTION} current="profile" />
      <div className="page-body">
        <ProfileForm action={saveProfileAction} initial={{ values, errors: {} }} />
      </div>
    </div>
  );
}
